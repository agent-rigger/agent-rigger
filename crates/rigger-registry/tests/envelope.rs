//! A1 — the envelope of the registry fails closed, and an entry does not.
//!
//! A test prefixed with an identifier realises that requirement. A1 is the one
//! this file exists for: **a registry whose top-level envelope is not the
//! expected one is refused by naming what was found and what was expected,
//! before anything is written, and it is never coerced into an empty registry**
//! — coercing it destroys the only description of what has been posed and makes
//! all of it unremovable in the same gesture. The tolerance is granted at the
//! level of **one entry**, never of the envelope.
//!
//! Each test works in its own directory: a registry's write puts a temporary
//! beside it, so two tests sharing a directory would see each other.

use std::fs;
use std::path::PathBuf;

use rigger_registry::{exit_code, Registry, RegistryError, IMPOSSIBLE_REQUEST, RUNTIME_FAILURE};

/// An empty working directory, private to this test.
fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-registry-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create the working directory");
    path
}

/// A registry written by the test, in the format on disk rather than through the
/// product's own renderer: a fixture built by the code under test would agree
/// with it whatever either of them did.
fn registry_with(dir: &std::path::Path, document: &str) -> Registry {
    let path = dir.join("registry");
    fs::write(&path, document).expect("write the registry");
    Registry::at(path)
}

/// One entry line, as the format writes it.
fn entry_line(id: &str, behaviour: &str, posed_by: &str, address: &str) -> String {
    format!("entry\t{id}\t{behaviour}\t{posed_by}\t{address}")
}

#[test]
fn a1_a_registry_written_by_a_version_this_build_does_not_read_is_refused_and_left_alone() {
    // GIVEN a registry whose envelope declares a format version this build does
    // not know.
    let dir = directory("newer-envelope");
    let document = format!(
        "rigger-registry 2\n{}\n",
        entry_line("acme/skill", "merge", "1.4", "/home/someone/settings.json")
    );
    let registry = registry_with(&dir, &document);
    let before = fs::read(registry.path()).expect("read the registry back");

    // WHEN a command that reads the registry runs.
    let failure = registry
        .read()
        .expect_err("a registry of an unknown format was read as if this build understood it");

    // THEN it fails while naming the version found and the version expected —
    // and not merely the one expected, which would leave its owner unable to
    // tell which product wrote this.
    match &failure {
        RegistryError::EnvelopeUnknown {
            path,
            found,
            expected,
        } => {
            assert_eq!(path, registry.path());
            assert_eq!(found, "2");
            assert_eq!(*expected, 1);
        }
        other => panic!("the refusal does not name the envelope: {other}"),
    }
    let message = failure.to_string();
    assert!(message.contains('2'), "{message}");
    assert!(message.contains('1'), "{message}");

    // AND the registry file is identical, byte for byte, to what it was — never
    // coerced into an empty registry, which would destroy the only description
    // of everything posed on this machine.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    assert_eq!(
        files(&dir),
        vec!["registry".to_string()],
        "the refusal left something beside the registry"
    );

    // AND the exit code tells this refusal apart from a usage error: a script
    // that cannot distinguish "your registry is from a newer product" from "you
    // mistyped a flag" retries the second forever.
    assert_eq!(exit_code(&failure), RUNTIME_FAILURE);
    assert_ne!(exit_code(&failure), IMPOSSIBLE_REQUEST);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a1_a_registry_without_an_envelope_names_the_absence_and_assumes_no_version() {
    // GIVEN a registry whose root document carries no version field at all.
    let dir = directory("no-envelope");
    let document = format!(
        "{}\n",
        entry_line("acme/skill", "merge", "1.4", "/home/someone/settings.json")
    );
    let registry = registry_with(&dir, &document);
    let before = fs::read(registry.path()).expect("read the registry back");

    // WHEN a read runs.
    let failure = registry
        .read()
        .expect_err("a registry with no envelope was read under an assumed version");

    // THEN it names the absence, and not an unexpected value: the two are
    // different events, and a single variant for both makes the message unable
    // to say which happened.
    assert!(
        matches!(&failure, RegistryError::EnvelopeMissing { path } if path == registry.path()),
        "the refusal does not name the absence of an envelope: {failure}"
    );

    // AND no default version is assumed: nothing was read, and nothing was
    // written.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// The same requirement on a document that opens with the marker and stops
/// there. It is the case a build could be tempted to complete from a default,
/// and completing it is what A1 forbids.
#[test]
fn a1_an_envelope_with_no_version_is_an_absence_and_not_an_unknown_value() {
    let dir = directory("truncated-envelope");
    let registry = registry_with(&dir, "rigger-registry\n");

    let failure = registry
        .read()
        .expect_err("an envelope carrying no version was completed from a default");

    assert!(
        matches!(&failure, RegistryError::EnvelopeMissing { .. }),
        "an envelope with no version was reported as an unexpected value: {failure}"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a1_one_unreadable_entry_out_of_twelve_is_unjudgeable_and_the_other_eleven_are_returned() {
    // GIVEN a registry whose envelope is valid and one of whose twelve entries
    // is unreadable.
    let dir = directory("one-corrupt-entry");
    let mut document = String::from("rigger-registry 1\n");
    for index in 0..11 {
        document.push_str(&entry_line(
            &format!("acme/skill-{index}"),
            "merge",
            "1.4",
            &format!("/home/someone/settings-{index}.json"),
        ));
        document.push('\n');
    }
    document.push_str("entry\tacme/skill-11\tmerge\n");
    let registry = registry_with(&dir, &document);

    // WHEN a read runs.
    let ledger = registry
        .read()
        .expect("one unreadable entry made the whole registry unreadable");

    // THEN the eleven readable entries are returned.
    assert_eq!(ledger.entries().len(), 11);
    assert_eq!(ledger.entries()[0].id(), "acme/skill-0");
    assert_eq!(ledger.entries()[10].id(), "acme/skill-10");

    // AND the twelfth is reported unjudgeable, with its reason — a report that
    // says only "unjudgeable" leaves its reader nothing to act on.
    assert_eq!(ledger.unjudgeable().len(), 1);
    let unreadable = &ledger.unjudgeable()[0];
    assert_eq!(unreadable.line(), 13);
    assert!(
        unreadable.reason().contains("posing version"),
        "the unjudgeable entry does not carry the reason it is one: {}",
        unreadable.reason()
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: no scenario of A1 says what becomes of an unreadable
/// entry when the registry is written again, and the answer decides whether the
/// tolerance is a tolerance at all.
///
/// Dropped on the next write, the unreadable line is gone for good — which is
/// the envelope's own damage at the size of one entry: the description of
/// something posed disappears, and what it describes becomes permanently
/// unremovable. So it comes back out, byte for byte.
#[test]
fn guard_an_unreadable_entry_is_written_back_unchanged() {
    use rigger_apply::SystemLiveness;
    use rigger_registry::{transact, Consent, Decision, Entry, Mutation, Outcome, Proposal};

    struct Granting;
    impl Consent for Granting {
        fn decide(&self, _: &Proposal<'_>) -> Decision {
            Decision::Granted
        }
    }

    let dir = directory("keep-unreadable");
    const UNREADABLE: &str = "entry\tacme/older\tmerge";
    let document = format!(
        "rigger-registry 1\n{}\n{UNREADABLE}\n",
        entry_line("acme/skill", "merge", "1.4", "/home/someone/settings.json")
    );
    let registry = registry_with(&dir, &document);

    let outcome = transact(
        &registry,
        &[Mutation::Upsert(Entry::new(
            "acme/other",
            "merge",
            "1.5",
            "/home/someone/other.json",
        ))],
        &Granting,
        &SystemLiveness,
    )
    .expect("the transaction must succeed");
    assert!(matches!(outcome, Outcome::Committed { .. }));

    let written = fs::read_to_string(registry.path()).expect("read the registry back");
    assert!(
        written.contains(UNREADABLE),
        "the write dropped the entry it could not read: {written}"
    );
    let reread = registry.read().expect("read the registry back");
    assert_eq!(reread.entries().len(), 2);
    assert_eq!(reread.unjudgeable().len(), 1);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a1_the_refusal_names_the_fact_and_the_expected_version_and_advises_no_remedy() {
    // GIVEN a registry of an unknown envelope.
    let dir = directory("no-remedy");
    let registry = registry_with(&dir, "rigger-registry 7\n");

    // WHEN the command refuses.
    let failure = registry.read().expect_err("the read must refuse");

    // THEN the whole message is this, and nothing else. It is pinned entire
    // rather than searched for forbidden words, because a list of forbidden
    // words does not close the set of ways to advise a remedy: "delete the file
    // and start again" and "move it aside" would both pass such a list. What
    // makes the property hold is that the message is built from the typed fields
    // of the refusal and has no free-text tail — and only an assertion on the
    // whole of it goes red when a tail is added.
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: the registry declares format version 7, and this build reads version 1 — it is \
             left exactly as it is, because it is the only description of what has been posed on \
             this machine",
            registry.path().display()
        )
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// The files present in a directory, sorted — enough to observe that nothing was
/// left beside the registry.
fn files(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read the directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}
