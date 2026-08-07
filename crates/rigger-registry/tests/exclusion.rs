//! A3 — reading, deciding and writing the registry hold under one exclusion.
//!
//! A test prefixed with an identifier realises that requirement. What is
//! measured here is each of the two stages that protect a registry against two
//! runs losing each other's records: **the write window holds under the
//! exclusion**, and **the registry is read again and the run's mutations
//! replayed onto it just before writing**. What is measured here too is what the
//! exclusion must *not* surround — the question asked of the user, and any read
//! path.
//!
//! **What no test in this file establishes**, and it is written where the types
//! that carry it are: that the two stages surround the *same* window. Code that
//! re-reads, replays, and takes the lock afterwards passes every test below and
//! loses updates. One run at a time produces the same file either way, so no
//! sequential test tells them apart — and the requirement's own scenario, two
//! runs overlapping in time, is a race nothing deterministic schedules. That
//! property is held by `Registry::reread` and `Fresh::commit`, whose types make
//! the wrong order impossible to write down.
//!
//! Each test works in its own directory: a lock lives beside its registry, so
//! two tests sharing a directory would contend for one.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{LockError, SystemLiveness};
use rigger_registry::{
    transact, Address, Consent, Decision, Entry, Mutation, Outcome, Posting, Proposal, Registry,
    RegistryError,
};

/// An empty working directory, private to this test.
fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-exclusion-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create the working directory");
    path
}

/// One entry line, as the format writes it: the seven fixed fields, then the
/// trace of the behaviour that posed.
fn entry_line(id: &str) -> String {
    format!(
        "entry\t{id}\tacme\tlink\t1.4\t/home/someone\t{id}.json\t0123456789abcdef\t/store/{id}\tlink"
    )
}

/// A registry carrying these identifiers, written by the test.
fn registry_with(dir: &Path, name: &str, ids: &[&str]) -> Registry {
    let mut document = String::from("rigger-registry 1\n");
    for id in ids {
        document.push_str(&entry_line(id));
        document.push('\n');
    }
    fs::create_dir_all(dir).expect("create the directory of the registry");
    let path = dir.join(name);
    fs::write(&path, document).expect("write the registry");
    Registry::at(path)
}

fn posing(id: &str) -> Mutation {
    Mutation::Upsert(Entry::posted(Posting {
        id: id.to_string(),
        provenance: "acme".to_string(),
        behaviour: "link".to_string(),
        posed_by: "1.5".to_string(),
        root: Address::new("/home/someone").expect("a UTF-8 address"),
        address: Address::new(format!("{id}.json")).expect("a UTF-8 address"),
        fingerprint: "0123456789abcdef".to_string(),
        trace: vec![format!("/store/{id}"), "link".to_string()],
    }))
}

fn identifiers(registry: &Registry) -> Vec<String> {
    let mut ids: Vec<String> = registry
        .read()
        .expect("read the registry back")
        .entries()
        .iter()
        .map(|entry| entry.id().to_string())
        .collect();
    ids.sort();
    ids
}

/// Consent that says yes, and does something first.
struct Granting<F: Fn(&Proposal<'_>)>(F);

impl<F: Fn(&Proposal<'_>)> Consent for Granting<F> {
    fn decide(&self, proposal: &Proposal<'_>) -> Decision {
        (self.0)(proposal);
        Decision::Granted
    }
}

#[test]
fn a3_an_entry_recorded_between_the_read_and_the_write_is_not_lost() {
    // GIVEN a registry carrying `E0`, and something writing `E1` into it after
    // this run has read it and before this run writes — which is what another
    // run committing in that interval looks like from here.
    let dir = directory("no-lost-update");
    let registry = registry_with(&dir, "registry", &["E0"]);
    let path = registry.path().to_path_buf();
    let by_another_run = Granting(move |_: &Proposal<'_>| {
        let mut document = fs::read_to_string(&path).expect("read the registry");
        document.push_str(&entry_line("E1"));
        document.push('\n');
        fs::write(&path, document).expect("another run records its entry");
    });

    // WHEN this run poses `E2`.
    let outcome = transact(&registry, &[posing("E2")], &by_another_run, &SystemLiveness)
        .expect("the transaction must succeed");
    assert!(matches!(outcome, Outcome::Committed { .. }));

    // THEN the registry carries all three. A write of the copy read before the
    // decision would carry `E0` and `E2`, and `E1` would be gone with no error
    // and nobody noticing — leaving whatever the other run posed permanently
    // unremovable.
    assert_eq!(identifiers(&registry), vec!["E0", "E1", "E2"]);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_the_write_window_does_not_open_while_another_run_holds_the_registry() {
    // GIVEN a run holding the exclusion of this registry.
    let dir = directory("window-excluded");
    let registry = registry_with(&dir, "registry", &["E0"]);
    let held = registry
        .lock()
        .acquire(&SystemLiveness)
        .expect("the first acquisition must succeed");

    // WHEN a second run tries to write.
    let failure = transact(
        &registry,
        &[posing("E1")],
        &Granting(|_: &Proposal<'_>| {}),
        &SystemLiveness,
    )
    .expect_err("a second run wrote the registry while another held it");

    // THEN it fails fast, naming the run that holds it — never waits, which
    // would turn a contended registry into a hung command.
    assert!(
        matches!(&failure, RegistryError::Locked(LockError::Held { path, .. }) if path == registry.lock().path()),
        "the write did not hold under the exclusion: {failure}"
    );

    // AND the registry is untouched.
    assert_eq!(identifiers(&registry), vec!["E0"]);
    drop(held);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_the_question_asked_of_the_user_is_not_asked_under_the_exclusion() {
    // GIVEN a run stopped on a request for confirmation — here, inside the
    // decision the caller provides, which is where that stop happens.
    let dir = directory("consent-outside");
    let registry = registry_with(&dir, "registry", &["E0"]);
    let taken_while_asking: RefCell<Option<Result<(), String>>> = RefCell::new(None);

    // WHEN a second run asks for the exclusion at that moment.
    let asking = Granting(|proposal: &Proposal<'_>| {
        let second_run = Registry::at(proposal.registry);
        let attempt = second_run
            .lock()
            .acquire(&SystemLiveness)
            .map(drop)
            .map_err(|err| err.to_string());
        *taken_while_asking.borrow_mut() = Some(attempt);
    });
    let outcome = transact(&registry, &[posing("E1")], &asking, &SystemLiveness)
        .expect("the transaction must succeed");

    // THEN it obtains it. An exclusion taken around the run would be held for as
    // long as somebody hesitates in front of the question, and the machine would
    // be unusable by a gesture its owner connects to nothing.
    let attempt = taken_while_asking
        .borrow()
        .clone()
        .expect("the decision was never asked for");
    assert_eq!(
        attempt,
        Ok(()),
        "the exclusion was held while the user was being asked"
    );
    assert!(matches!(outcome, Outcome::Committed { .. }));
    assert_eq!(identifiers(&registry), vec!["E0", "E1"]);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_a_read_path_takes_nothing_and_writes_nothing() {
    // GIVEN a run holding the exclusion.
    let dir = directory("read-path");
    let registry = registry_with(&dir, "registry", &["E0", "E1"]);
    let before = fs::read(registry.path()).expect("read the registry file");
    let held = registry
        .lock()
        .acquire(&SystemLiveness)
        .expect("the acquisition must succeed");

    // WHEN a plain consultation runs beside it.
    let ledger = registry
        .read()
        .expect("a consultation failed while another run held the registry");

    // THEN it answers without waiting.
    assert_eq!(ledger.entries().len(), 2);

    // AND it writes nothing — not even a normalisation of what it read, which
    // would put this path among the writers the exclusion exists to order,
    // without it ever having taken the exclusion.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    drop(held);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_the_exclusion_follows_the_registry_it_guards() {
    // GIVEN two registries at two locations — what an environment override
    // already allows, and what profiles will make routine.
    let dir = directory("lock-follows");
    let first = registry_with(&dir.join("one"), "registry", &["E0"]);
    let second = registry_with(&dir.join("two"), "registry", &["E0"]);

    // WHEN a run takes the exclusion of the first.
    let held = first
        .lock()
        .acquire(&SystemLiveness)
        .expect("the first acquisition must succeed");

    // THEN the lock taken is the one beside the registry actually used.
    assert_eq!(held.path(), first.lock().path());
    assert_eq!(
        first.lock().path().parent(),
        first.path().parent(),
        "the lock does not live beside the registry it guards"
    );

    // AND the second registry is not held by it: a fixed path would serialise
    // two unrelated pieces of work while leaving each registry guarded by an
    // exclusion that designates neither.
    assert_ne!(first.lock().path(), second.lock().path());
    let other = second
        .lock()
        .acquire(&SystemLiveness)
        .expect("a lock at a fixed path made two unrelated registries contend");
    drop(other);
    drop(held);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: nothing in A3 says what happens when the proof of
/// holding names another registry's lock, and the answer decides whether the
/// proof proves anything. Accepted, it would let a run hold the exclusion of one
/// registry and write another — the exclusion doing nothing at all while
/// appearing to work.
#[test]
fn guard_a_lock_held_over_another_registry_does_not_admit_a_write() {
    let dir = directory("lock-elsewhere");
    let first = registry_with(&dir.join("one"), "registry", &["E0"]);
    let second = registry_with(&dir.join("two"), "registry", &["E0"]);

    let held = first
        .lock()
        .acquire(&SystemLiveness)
        .expect("the acquisition must succeed");
    let failure = second
        .reread(&held)
        .expect_err("a write was admitted under the exclusion of another registry");

    assert!(
        matches!(&failure, RegistryError::LockElsewhere { registry, .. } if registry == second.path()),
        "the refusal does not name the registry it was asked to write: {failure}"
    );
    drop(held);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: a refusal to consent is an answer, not a failure, and it
/// must leave the registry alone. Written as a failure, a script cannot tell
/// "the user said no" from "the machine broke".
#[test]
fn guard_a_refused_consent_writes_nothing_and_is_not_a_failure() {
    struct Refusing;
    impl Consent for Refusing {
        fn decide(&self, _: &Proposal<'_>) -> Decision {
            Decision::Refused
        }
    }

    let dir = directory("consent-refused");
    let registry = registry_with(&dir, "registry", &["E0"]);
    let before = fs::read(registry.path()).expect("read the registry file");

    let outcome = transact(&registry, &[posing("E1")], &Refusing, &SystemLiveness)
        .expect("a refusal to consent was reported as a failure");
    assert!(matches!(outcome, Outcome::Refused { .. }));
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    assert!(
        !registry.lock().path().exists(),
        "the exclusion was taken for a write that never happened"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}
