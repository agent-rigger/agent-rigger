//! The whole chain, once: pose one artefact by link, record it, and take it
//! back off by **replaying its recorded trace**.
//!
//! A test prefixed with an identifier realises that requirement. A4 — the
//! transaction gives the machine back, and its nominal half is here: what a
//! pose put on a machine, its removal takes off, byte for byte, the shared
//! store included. A5 — the registry records the behaviour and the version that
//! posed, which is what lets a later build refuse by naming them rather than go
//! silent.
//!
//! **A5's refusal is here too, and it is here rather than in a file of its own
//! because it needs this machine.** What A5 requires is that the set of
//! behaviours never shrink in silence: when a trace names a behaviour the
//! running version no longer carries, the product refuses by naming the
//! behaviour, the version that posed it, the file and what has to be undone by
//! hand — and it never recognises the shape of what was posed in order to undo
//! it anyway. Measuring "it did not undo it anyway" means having something on a
//! machine and comparing that machine before and after, which is what
//! [`Machine::snapshot`] is. A second harness beside this one would be a second
//! definition of the same sequence, and two definitions drift.
//!
//! **What the sequence below is, and where it will live.** Reading the
//! registry, posing, recording, then replaying and unrecording is the order a
//! command carries out. The command surface is not built in this slice, so the
//! order is written here — and it is written once, in `install` and `uninstall`
//! below, rather than spread through the scenarios, so that the day it moves
//! into the command surface there is one place to read it from.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{pose, withdraw, OnDisk, SystemLiveness, SystemPracticability};
use rigger_plan::{replay, BehaviourName, Digest, Fragment, Placement, Referents};
use rigger_registry::{
    exit_code, resolve_behaviour, transact, Address, Consent, Decision, Entry, Identity, Ledger,
    Mutation, Outcome, Posting, Proposal, Registry, RegistryError, IMPOSSIBLE_REQUEST, POSED_BY,
    RUNTIME_FAILURE,
};

/// The bytes of the artefact the scenarios pose.
const ARTEFACT: &str = "# Review\n\nRead the diff before the description.\n";

/// What names a record of the one catalogue these scenarios pose from.
fn acme(id: &str) -> Identity {
    Identity {
        provenance: "acme".to_string(),
        id: id.to_string(),
    }
}

/// Consent that says yes. The question is asked before the exclusion is taken,
/// and this crate never reads a terminal.
struct Granting;

impl Consent for Granting {
    fn decide(&self, _: &Proposal<'_>) -> Decision {
        Decision::Granted
    }
}

/// A machine: the part a pose writes on, and the product's own state beside it.
///
/// `disk/` is what "as it was, byte for byte" is measured over — the root the
/// product poses under and the shared store. `state/` holds the registry, which
/// is a file the product owns and which does not exist before the first write.
struct Machine {
    path: PathBuf,
}

impl Machine {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("rigger-bullet-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        for directory in ["disk/root", "disk/other-root", "disk/store", "state"] {
            fs::create_dir_all(path.join(directory)).expect("create the working directory");
        }
        Self { path }
    }

    fn root(&self) -> PathBuf {
        self.path.join("disk/root")
    }

    fn store(&self, key: &str) -> PathBuf {
        self.path.join("disk/store").join(key)
    }

    fn registry(&self) -> Registry {
        Registry::at(self.path.join("state/registry"))
    }

    /// Everything a pose may have changed, as bytes and as link targets.
    fn snapshot(&self) -> Vec<(String, String)> {
        fn walk(base: &Path, directory: &Path, found: &mut Vec<(String, String)>) {
            let mut paths: Vec<PathBuf> = fs::read_dir(directory)
                .expect("read the directory")
                .map(|entry| entry.expect("read the entry").path())
                .collect();
            paths.sort();
            for path in paths {
                let named = path
                    .strip_prefix(base)
                    .expect("a path under the base")
                    .display()
                    .to_string();
                let metadata = fs::symlink_metadata(&path).expect("read the metadata");
                if metadata.file_type().is_symlink() {
                    let to = fs::read_link(&path).expect("read the link");
                    found.push((named, format!("link -> {}", to.display())));
                } else if metadata.is_dir() {
                    found.push((named, "directory".to_string()));
                    walk(base, &path, found);
                } else {
                    let bytes = fs::read(&path).expect("read the file");
                    found.push((named, format!("file {bytes:?}")));
                }
            }
        }

        let base = self.path.join("disk");
        let mut found = Vec::new();
        walk(&base, &base, &mut found);
        found
    }
}

/// Poses one artefact by link under `root`, and records it.
///
/// **The order is the substance, and so is what happens between the two.** The
/// pose refuses before it changes anything if the registry could not hold its
/// trace. It then changes the machine, and only afterwards is the record
/// written — and between those two the artefact is on the machine while nothing
/// describes it. The transaction of the pose has **already given the machine
/// back**; it succeeded. So a failure to record is compensated here, by
/// replaying the very trace that was about to be recorded, and the run reports
/// the failure rather than leaving behind something no removal could ever reach.
fn install(
    machine: &Machine,
    id: &str,
    root: &Path,
    address: &str,
    key: &str,
) -> Result<Entry, RegistryError> {
    let store = machine.store(key);
    let posted = pose(
        BehaviourName::Link,
        &root.join(address),
        &Fragment::Artefact {
            store,
            contents: ARTEFACT.to_string(),
            placement: Placement::Link,
            executable: false,
        },
        &OnDisk,
        &SystemPracticability,
    )
    .expect("the pose must succeed");

    let entry = Entry::posted(Posting {
        id: id.to_string(),
        provenance: "acme".to_string(),
        behaviour: BehaviourName::Link.as_str().to_string(),
        posed_by: POSED_BY.to_string(),
        // The effective root **at the moment of the pose**, and the address
        // under it. Recording the address alone would leave a later removal to
        // resolve it against whatever the environment names then.
        root: Address::new(root).expect("a UTF-8 root"),
        address: Address::new(Path::new(address)).expect("a UTF-8 address"),
        fingerprint: posted.fingerprint.to_string(),
        trace: posted.trace,
    })
    .expect("a trace the pose already proved recordable records again here");
    let outcome = match transact(
        &machine.registry(),
        &[Mutation::Upsert(entry.clone())],
        &Granting,
        &SystemLiveness,
    ) {
        Ok(outcome) => outcome,
        Err(err) => {
            take_back_unrecorded(machine, &entry);
            return Err(err);
        }
    };
    assert!(matches!(outcome, Outcome::Committed { .. }));
    Ok(entry)
}

/// Takes back off what was posed and never recorded, by replaying the trace that
/// was about to be written.
///
/// **Its referents are asked of the registry as it can still be read**, and a
/// registry that cannot be read at all answers `Remaining`. The asymmetry is the
/// one the count itself is built on: keeping a materialisation nobody designates
/// wastes a file its owner can delete, and taking away one that is still
/// designated leaves links pointing at nothing and the thing they pointed at
/// gone.
fn take_back_unrecorded(machine: &Machine, entry: &Entry) {
    // Through the product's own resolution, and not through a second one written
    // here: two definitions of where the closed set closes would drift, and the
    // one in the tests is the one nobody ships. This entry was built by this run,
    // so its behaviour is one this build carries.
    let name = resolve_behaviour(entry).expect("a behaviour this run itself posed through");
    let trace = replay(name, entry.trace()).expect("the trace must read back");
    let referents = match (trace.store(), machine.registry().read()) {
        (Some(store), Ok(ledger)) => ledger.referents(store, entry.identity()),
        (Some(_), Err(_)) => Referents::Remaining,
        (None, _) => Referents::Last,
    };
    withdraw(name, &entry.at(), &trace, referents, &OnDisk)
        .expect("what a run posed and could not record must be taken back off");
}

/// Takes one thing back off by replaying its recorded trace, and takes its
/// record out.
///
/// Nothing here looks at the machine to work out what was posed: the behaviour
/// is resolved from the **name** the entry carries, the trace is read back out
/// of the fields the entry carries, and the address is the recorded root joined
/// with the recorded address.
///
/// **The resolution is the product's, and its refusal comes back out of here.**
/// A name the closed set no longer contains is where this stops: nothing is
/// undone, nothing is taken out of the registry, and the caller is handed the
/// refusal that names the behaviour, the version that posed it, the file and
/// what the record holds. Resolved here with a second `parse` of its own, that
/// refusal would exist in the product and be unreachable through the one
/// sequence a command carries out.
fn uninstall(machine: &Machine, id: &str) -> Result<(), RegistryError> {
    let registry = machine.registry();
    let ledger: Ledger = registry.read().expect("read the registry");
    let entry = ledger
        .entries()
        .iter()
        .find(|entry| entry.id() == id)
        .expect("the registry must carry the entry");

    let name = resolve_behaviour(entry)?;
    let trace = replay(name, entry.trace()).expect("the trace must read back");
    let referents = match trace.store() {
        Some(store) => ledger.referents(store, entry.identity()),
        None => Referents::Last,
    };

    withdraw(name, &entry.at(), &trace, referents, &OnDisk).expect("the removal must succeed");
    let outcome = transact(
        &registry,
        &[Mutation::Remove {
            identity: entry.identity().clone(),
        }],
        &Granting,
        &SystemLiveness,
    )
    .expect("the record must be taken out");
    assert!(matches!(outcome, Outcome::Committed { .. }));
    Ok(())
}

#[test]
fn a4_a_pose_by_link_and_its_replayed_removal_leave_the_machine_as_it_was() {
    let machine = Machine::new("whole-chain");
    let before = machine.snapshot();

    // WHEN one artefact is posed and recorded.
    install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");

    // THEN the address designates the shared store, and the store holds the
    // artefact once.
    let address = machine.root().join("review.md");
    assert!(
        fs::symlink_metadata(&address)
            .expect("something must be at the address")
            .file_type()
            .is_symlink(),
        "a pose by link must leave a link, and not a copy nobody asked for"
    );
    assert_eq!(
        fs::read_link(&address).expect("read the link"),
        machine.store("acme-review-1.0")
    );
    assert_eq!(
        fs::read_to_string(machine.store("acme-review-1.0")).expect("read the store entry"),
        ARTEFACT
    );

    // AND the registry describes it.
    let ledger = machine.registry().read().expect("read the registry");
    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(ledger.entries()[0].at(), address);

    // WHEN it is taken back off by replaying that record.
    uninstall(&machine, "acme/review").expect("the removal must succeed");

    // THEN the machine is what it was, byte for byte, the shared store
    // included, and the registry no longer describes it.
    assert_eq!(machine.snapshot(), before);
    assert!(machine
        .registry()
        .read()
        .expect("read the registry")
        .entries()
        .is_empty());
}

/// A name no version of this product ever carried in its closed set. The set is
/// `link`, `merge`, `delegate` and `probe`; `merge/toml` is the grammar written
/// after the member, which a catalogue may write and which the set never
/// contains — so it stands for what an entry looks like once the set has shrunk
/// out from under it.
const GONE: &str = "merge/toml";

/// The version that posed the entries below. Not this build's: the whole point
/// is a record written by a product that still carried what this one does not.
const POSED_BEFORE: &str = "1.4";

/// Writes a registry holding these entry lines, in the format on disk rather
/// than through the product's own renderer.
///
/// A fixture built by the code under test would agree with it whatever either of
/// them did — and here it could not be built at all: a trace of a behaviour that
/// is not in the set is one this build has no way to record.
fn registry_holding(machine: &Machine, lines: &[String]) -> Registry {
    let registry = machine.registry();
    let mut document = String::from("rigger-registry 2\n");
    for line in lines {
        document.push_str(line);
        document.push('\n');
    }
    fs::write(registry.path(), document).expect("write the registry");
    registry
}

/// One entry line naming a behaviour outside the closed set, as an older build
/// would have left it: the named fields, then the trace that build wrote.
fn line_posed_by_a_gone_behaviour(root: &Path, address: &str, trace: &[&str]) -> String {
    let mut line = format!(
        "entry\tid=acme/review\tprovenance=acme\tbehaviour={GONE}\tposed_by={POSED_BEFORE}\t\
         root={}\taddress={address}\tfingerprint=0123456789abcdef",
        root.display()
    );
    if !trace.is_empty() {
        line.push_str("\ttrace=");
        line.push_str(&trace.join("\\t"));
    }
    line
}

/// Guard, not scenario: what the **read** of the registry does with an entry
/// naming a behaviour outside the closed set. No scenario of A5 names it, and
/// the answer decides whether A5's refusal ever happens at all.
///
/// The decoder holds the behaviour as a name among seven fixed fields and takes
/// everything after them as the trace without knowing its arity, so it never
/// resolves the name. Resolve it there instead and the entry stops being a
/// readable entry with an unresolved behaviour: it becomes an unreadable line,
/// A1's tolerance reports it unjudgeable with the wrong reason, and the refusal
/// that has to name the behaviour, the version, the file and what to undo by
/// hand never happens. The property holds by the shape of the decoder and by no
/// test — which is what this one is for.
///
/// **Bounded to the read, and deliberately.** A5 also requires that a
/// **diagnostic** report such an entry as unjudgeable, with its reason. No
/// diagnostic exists yet. What is locked here is that the *read* of the registry
/// hands the entry back among the entries; nothing here says what a report of
/// the machine's state should do with it.
#[test]
fn guard_an_entry_naming_a_behaviour_outside_the_set_is_read_back_as_an_entry() {
    let machine = Machine::new("unresolved-behaviour-reads");
    let registry = registry_holding(
        &machine,
        &[line_posed_by_a_gone_behaviour(
            &machine.root(),
            "settings.toml",
            &["jsonc", "an inverse this build cannot read"],
        )],
    );

    let ledger = registry.read().expect("read the registry");

    assert_eq!(
        ledger.entries().len(),
        1,
        "an entry naming a behaviour outside the set was not read back as an entry, so the \
         refusal that has to name it can never happen"
    );
    assert!(
        ledger.unjudgeable().is_empty(),
        "the read judged the behaviour name, and the entry became an unreadable line"
    );
    assert_eq!(ledger.entries()[0].behaviour(), GONE);
    assert_eq!(ledger.entries()[0].posed_by(), POSED_BEFORE);
}

#[test]
fn a5_a_removal_through_a_behaviour_this_build_lost_refuses_by_naming_four_things() {
    // GIVEN a record of something posed through a behaviour whose name the
    // closed set of this build does not contain, by a version that still
    // carried it.
    let machine = Machine::new("behaviour-gone");
    let registry = registry_holding(
        &machine,
        &[line_posed_by_a_gone_behaviour(
            &machine.root(),
            "settings.toml",
            &["jsonc", "an inverse this build cannot read"],
        )],
    );
    let before = fs::read(registry.path()).expect("read the registry file");

    // WHEN the removal of that entry is asked for.
    let failure =
        uninstall(&machine, "acme/review").expect_err("a behaviour this build lost was resolved");

    // THEN the refusal names four things, in typed fields: the behaviour as the
    // record spells it, the version that posed it, the file, and what the record
    // holds to be undone by hand. In its text alone they would have to be parsed
    // back out of a sentence, and a caller that cannot name them cannot act.
    match &failure {
        RegistryError::BehaviourGone {
            behaviour,
            posed_by,
            address,
            trace,
        } => {
            assert_eq!(behaviour, GONE);
            assert_eq!(posed_by, POSED_BEFORE);
            assert_eq!(address, &machine.root().join("settings.toml"));
            assert_eq!(
                trace,
                &vec![
                    "jsonc".to_string(),
                    "an inverse this build cannot read".to_string()
                ],
                "the refusal hands back the fields as recorded — this build cannot read them, and \
                 guessing what they mean is the recognition of shapes it refuses to do"
            );
        }
        other => panic!("the refusal does not name what was posed: {other}"),
    }

    // AND the whole message is this, and nothing else. It is pinned entire
    // rather than searched for the four, because a message may name them and go
    // on to advise a remedy the product cannot carry out.
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: posed through behaviour `{GONE}` by version {POSED_BEFORE} of the product, and \
             this build carries no behaviour of that name — nothing was undone, the record is \
             left exactly as it is, and no neighbouring behaviour was tried in its place; what \
             the record holds, to be undone by hand, is [`jsonc`, `an inverse this build cannot \
             read`]",
            machine.root().join("settings.toml").display()
        )
    );

    // AND the entry stays in the registry. It is the only description of
    // something that is still on the machine: taken out, what it describes could
    // never be found again to be removed.
    let ledger = registry.read().expect("read the registry");
    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(ledger.entries()[0].id(), "acme/review");

    // AND it is neither purged nor reported as removed. The file is identical
    // byte for byte to what it was, and the run answered a refusal rather than a
    // removal — without both, "it stays" is true by nobody having looked.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);

    // AND the exit code tells this refusal apart from a usage error: a script
    // that cannot distinguish "this build no longer carries that behaviour" from
    // "you mistyped a flag" retries the second for ever.
    assert_eq!(exit_code(&failure), RUNTIME_FAILURE);
    assert_ne!(exit_code(&failure), IMPOSSIBLE_REQUEST);
}

/// A5 · 3 — no fallback inference.
///
/// **The fixture departs from the letter of the scenario, and the departure is
/// what makes the test measure anything.** The scenario has the product fall
/// back on a *merge* behaviour and demands that nothing be written to the
/// document. In this product no fallback on a member of the closed set can touch
/// anything: a merge trace is not recordable, and two members have no body at
/// all. A test whose mutant dies before it acts is green whatever the code does.
///
/// So the record here carries a trace of **link** shape — a store entry, a
/// placement, a fingerprint — under a behaviour name the set does not contain.
/// A fallback on `link` then really acts: it takes the address back and, at the
/// last referent, the shared store entry with it. What is measured is the
/// invariant the scenario is about: **an unresolved name is never replaced by a
/// resolvable one, and nothing a pose wrote changes.**
///
/// "What a pose wrote" and not "the machine", because that is the width of the
/// observable: [`Machine::snapshot`] walks the root posed under and the shared
/// store, and not the registry beside them. That the **record** stays is the
/// other scenario's clause, and it is pinned there by reading the registry file
/// back byte for byte.
#[test]
fn a5_a_behaviour_this_build_lost_is_not_replaced_by_one_it_still_carries() {
    // GIVEN something really posed by link, and a record of it that names a
    // behaviour outside the closed set while keeping the trace of the pose.
    let machine = Machine::new("no-fallback");
    let posted = install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");
    record_again(&machine, &posted, GONE, POSED_BEFORE);
    let before = machine.snapshot();

    // WHEN the removal is asked for.
    let outcome = uninstall(&machine, "acme/review");

    // THEN nothing on the machine moved — the link is still there, the shared
    // store entry is still there, and its bytes are what they were. A neighbour
    // tried in place of the name would have unlinked the address and taken the
    // store entry away with it at the last referent, so this comparison is asked
    // **before** anything about the answer: a refusal that arrives after the
    // machine has already been changed is not the property A5 is about.
    assert_eq!(
        machine.snapshot(),
        before,
        "a behaviour was tried in place of the one the record names, and it acted"
    );

    // AND what came back is the refusal, naming the behaviour the record spells.
    let failure = outcome.expect_err("a behaviour this build lost was resolved");
    assert!(
        matches!(&failure, RegistryError::BehaviourGone { behaviour, .. } if behaviour == GONE),
        "the refusal does not name the behaviour the record spells: {failure}"
    );
}

/// Records the same pose again under another behaviour name and another posing
/// version, keeping everything else — the trace the pose wrote included.
///
/// **It is the only way to get a record `install` cannot write.** `install`
/// writes the running build's own version and a behaviour of the closed set, so
/// a record laid down by the harness always carries both; a scenario about a
/// version that is not this one, or a behaviour that is not in the set, has no
/// fixture without this.
///
/// It goes through the product's own write path rather than editing the file, so
/// what comes back is a record the product itself can produce — and the trace
/// stays exactly what `link` recorded, which is what lets a removal that
/// resolved the name actually act.
fn record_again(machine: &Machine, posted: &Entry, behaviour: &str, posed_by: &str) {
    // The trace this entry actually carries is a link trace — `install` is the
    // only thing that wrote it — so it is read back through the behaviour that
    // can replay it, never through `behaviour`: that parameter names what the
    // *new* record claims, deliberately outside the closed set in some
    // scenarios, and resolving through it here would refuse before the
    // fixture could even be built.
    let trace = replay(BehaviourName::Link, posted.trace()).expect("a link trace reads back");
    let outcome = transact(
        &machine.registry(),
        &[Mutation::Upsert(
            Entry::posted(Posting {
                id: posted.id().to_string(),
                provenance: posted.provenance().to_string(),
                behaviour: behaviour.to_string(),
                posed_by: posed_by.to_string(),
                root: Address::new(posted.root()).expect("a UTF-8 root"),
                address: Address::new(posted.address()).expect("a UTF-8 address"),
                fingerprint: posted.fingerprint().to_string(),
                trace,
            })
            .expect("a link trace records"),
        )],
        &Granting,
        &SystemLiveness,
    )
    .expect("the record must be rewritten");
    assert!(matches!(outcome, Outcome::Committed { .. }));
}

/// A5 · 4 — **a record posed by another version of the product, in a behaviour
/// the closed set still carries, is removed exactly as any other**, and the
/// difference in version produces no warning and no extra work.
///
/// **Two departures from the letter of the scenario, both forced.** The scenario
/// names a behaviour `merge/jsonc`: the closed set carries bare names, and a
/// merge trace is not recordable by this build in the first place — `link` is
/// the only member whose trace replays, so it is the member here. And the
/// scenario has the running binary at version `2.0`: the version of this build
/// is what its own package declares, so what can be asserted is the
/// **inequality** with the recorded version, never a target number.
///
/// **Why there is no assertion that nothing warned.** The value a successful
/// resolution answers has nowhere to put a warning, so a build that wanted to
/// remark on the version would have to change that type first. The account of
/// that choice lives on `resolve_behaviour`, where the type is, and is not
/// repeated here: two copies of one argument drift apart, and the one nobody
/// updates is the one somebody reads.
///
/// **"No slowdown" is two halves, and only one of them is measurable.** That no
/// extra work is undertaken because the versions differ is a property of the
/// path taken, and it is exactly what a mutation comparing the recorded version
/// with the running one takes away — this test is what goes red then. The
/// elapsed time is **not measured, and deliberately**: the clause carries no
/// threshold, no instrument and no reference, so any assertion on a duration
/// would measure the machine — red on a loaded build agent, green on code that
/// had doubled its work.
#[test]
fn a5_a_record_posed_by_another_version_is_removed_exactly_as_any_other() {
    // GIVEN something posed and recorded, and the record laid down again under a
    // version that is not this build's, in a behaviour the set still carries.
    let machine = Machine::new("another-version");
    let before = machine.snapshot();
    let posted = install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");
    record_again(
        &machine,
        &posted,
        BehaviourName::Link.as_str(),
        POSED_BEFORE,
    );

    // AND the record really carries a version other than this build's —
    // otherwise the scenario has no object, and a removal that refused on a
    // version difference would pass this test.
    let ledger = machine.registry().read().expect("read the registry");
    assert_eq!(ledger.entries()[0].posed_by(), POSED_BEFORE);
    assert_ne!(
        ledger.entries()[0].posed_by(),
        POSED_BY,
        "the fixture records the version this build writes, so it measures nothing"
    );
    assert_eq!(
        ledger.entries()[0].behaviour(),
        BehaviourName::Link.as_str()
    );

    // WHEN the removal is asked for.
    uninstall(&machine, "acme/review").expect("the removal must succeed");

    // THEN it runs as any other: the machine is what it was, byte for byte, the
    // shared store included, and the registry no longer describes it.
    assert_eq!(machine.snapshot(), before);
    assert!(machine
        .registry()
        .read()
        .expect("read the registry")
        .entries()
        .is_empty());
}

#[test]
fn a5_the_record_carries_the_behaviour_the_version_and_the_fingerprint_of_what_was_posed() {
    let machine = Machine::new("what-the-record-carries");

    install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");

    let ledger = machine.registry().read().expect("read the registry");
    let entry = &ledger.entries()[0];

    assert_eq!(entry.id(), "acme/review");
    assert_eq!(entry.provenance(), "acme");
    assert_eq!(
        entry.behaviour(),
        "link",
        "the behaviour is recorded as a name, so that a build whose closed set no longer carries \
         it can refuse by naming it rather than go silent"
    );
    assert_eq!(entry.posed_by(), POSED_BY);
    assert_eq!(entry.root(), machine.root());
    assert_eq!(entry.address(), Path::new("review.md"));
    assert_eq!(
        entry.fingerprint(),
        Digest::of(ARTEFACT.as_bytes()).to_string(),
        "the fingerprint is what tells the product's own writing from somebody else's rewriting"
    );
    assert_eq!(
        replay(BehaviourName::Link, entry.trace())
            .expect("the trace must read back")
            .store(),
        Some(machine.store("acme-review-1.0").as_path()),
        "the inverse must name the shared store entry: without it a removal has nothing to count \
         referents against"
    );
}

#[test]
fn a4_a_removal_replays_the_root_the_pose_recorded_and_not_the_one_in_force_now() {
    // GIVEN a pose made under one effective root, and a machine whose root has
    // since been overridden to another. Without the recorded root, the removal
    // looks under the root in force now, finds nothing, takes the entry out of
    // the registry all the same, and leaves the files where they are — a dirty
    // machine that believes itself clean.
    let machine = Machine::new("another-root");
    let posed_under = machine.root();
    let in_force_now = machine.path.join("disk/other-root");
    let someone_elses = in_force_now.join("review.md");
    fs::write(&someone_elses, "what its owner wrote\n").expect("write the owner's file");

    install(
        &machine,
        "acme/review",
        &posed_under,
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");
    assert!(posed_under.join("review.md").exists());

    // WHEN the removal runs, with the other root in force.
    uninstall(&machine, "acme/review").expect("the removal must succeed");

    // THEN what was posed is gone, and what lives under the root in force now
    // was never touched.
    assert!(
        !posed_under.join("review.md").exists(),
        "the removal must reach what the pose actually put on the machine"
    );
    assert_eq!(
        fs::read_to_string(&someone_elses).expect("the other root must be untouched"),
        "what its owner wrote\n"
    );
}

#[test]
fn a4_one_materialisation_serves_two_things_and_goes_with_the_last_of_them() {
    let machine = Machine::new("shared-store");
    let before = machine.snapshot();
    let store = machine.store("acme-review-1.0");

    // GIVEN two things posed from the same artefact — one materialisation, two
    // addresses designating it.
    install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");
    install(
        &machine,
        "acme/review-too",
        &machine.root(),
        "review-too.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");
    assert_eq!(
        fs::read_dir(machine.path.join("disk/store"))
            .expect("read the store")
            .count(),
        1,
        "the artefact must be materialised once, whatever designates it"
    );

    // WHEN the first is taken off.
    uninstall(&machine, "acme/review").expect("the removal must succeed");

    // THEN the materialisation stays, because something else still designates
    // it — and that something else still resolves.
    assert!(
        store.exists(),
        "taking the store entry away while something designates it leaves that link pointing at \
         nothing"
    );
    assert_eq!(
        fs::read_to_string(machine.root().join("review-too.md")).expect("the other link resolves"),
        ARTEFACT
    );

    // WHEN the last one is taken off.
    uninstall(&machine, "acme/review-too").expect("the removal must succeed");

    // THEN the machine is what it was, byte for byte, the shared store
    // included.
    assert!(!store.exists());
    assert_eq!(machine.snapshot(), before);
}

#[test]
fn guard_an_entry_whose_trace_cannot_be_read_counts_as_a_referent() {
    // The two errors are not symmetric. Keeping a store entry nobody designates
    // wastes a file somebody can delete; taking away one that is still
    // designated leaves links pointing at nothing and the thing they pointed at
    // gone. So a trace this build cannot read is treated as possibly
    // designating it.
    let machine = Machine::new("unreadable-referent");
    let store = machine.store("acme-review-1.0");
    install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");

    let registry = machine.registry();
    let document = fs::read_to_string(registry.path()).expect("read the registry");
    fs::write(
        registry.path(),
        format!(
            "{document}entry\tid=acme/other\tprovenance=acme\tbehaviour=link\tposed_by=1.4\t\
             root=/home/someone\taddress=other.md\tfingerprint=abc\n"
        ),
    )
    .expect("write a line that records no trace at all");
    let ledger = registry.read().expect("read the registry");

    // The added line is a readable entry carrying an empty trace, and not an
    // illegible line. Were the trace a required field, this line would be
    // unjudgeable — and the count below would answer `Remaining` because of the
    // illegible line rather than because of the trace, leaving this guard green
    // while measuring nothing.
    assert_eq!(ledger.entries().len(), 2);
    assert!(ledger.unjudgeable().is_empty());
    assert!(ledger.entries()[1].trace().is_empty());

    assert_eq!(
        ledger.referents(&store, &acme("acme/review")),
        Referents::Remaining,
        "an entry whose trace does not read back must not be counted as designating nothing"
    );
}

/// The same guard on the other half of the same branch.
///
/// Counting referents stops at the first refusal, and there are **two** ways to
/// get one: the name is outside the closed set, or the trace does not read back.
/// The guard above builds the second and leaves the first untouched, so a build
/// that stopped counting an unresolved **name** as a referent would keep the
/// whole suite green — and this is the half the removal path now argues about,
/// where an unresolved name is refused rather than swallowed.
///
/// What it would cost is one step worse than the guard above, because the two
/// answers meet on one machine: the shared store entry goes away under an entry
/// whose refusal keeps naming a file that no longer exists, so what that record
/// describes can never be found again. The entry below carries a link trace that
/// reads back perfectly and designates **another** store — so if its name
/// resolved, this would answer `Last`, and only the unresolved name makes it
/// `Remaining`.
#[test]
fn guard_an_entry_naming_a_behaviour_outside_the_set_counts_as_a_referent() {
    let machine = Machine::new("unresolved-referent");
    let store = machine.store("acme-review-1.0");
    install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");

    let registry = machine.registry();
    let document = fs::read_to_string(registry.path()).expect("read the registry");
    fs::write(
        registry.path(),
        format!(
            "{document}entry\tid=acme/other\tprovenance=acme\tbehaviour={GONE}\t\
             posed_by={POSED_BEFORE}\troot=/home/someone\taddress=other.md\tfingerprint=abc\t\
             trace=/store/another\\tlink\\t0123456789abcdef\n"
        ),
    )
    .expect("write a line naming a behaviour outside the closed set");
    let ledger = registry.read().expect("read the registry");

    // The added line is a readable entry — otherwise the count would answer
    // `Remaining` because of an illegible line, and this guard would pass
    // without measuring the name at all.
    assert_eq!(ledger.entries().len(), 2);
    assert!(ledger.unjudgeable().is_empty());

    assert_eq!(
        ledger.referents(&store, &acme("acme/review")),
        Referents::Remaining,
        "an entry whose behaviour is outside the closed set must not be counted as designating \
         nothing: its trace is not read, so nothing here can say what it designates"
    );
}

#[test]
fn a4_a_pose_whose_record_could_not_be_written_leaves_nothing_on_the_machine() {
    // GIVEN a machine whose registry cannot be written — here its exclusion is
    // occupied by a directory, and a full disk, a permission or a lock held
    // elsewhere put the run in the same place.
    //
    // This is the window A4 names literally: the pose has landed and the record
    // has not. The transaction of the pose gave nothing back, because it did not
    // fail — it succeeded, and what it posed is on the machine described by
    // nothing. Left there, it is unremovable for good: the removal replays a
    // trace, and no trace was ever recorded.
    let machine = Machine::new("registry-unwritable");
    let before = machine.snapshot();
    fs::create_dir_all(machine.path.join("state/registry.lock"))
        .expect("occupy the exclusion of the registry");

    // WHEN the run poses and then fails to record.
    let failure = install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect_err("a run that could not record reported a pose");

    // THEN the failure names the registry, and the machine carries nothing the
    // registry does not describe.
    assert!(
        failure.to_string().contains("registry"),
        "the failure must name what could not be written: {failure}"
    );
    assert_eq!(
        machine.snapshot(),
        before,
        "the artefact stayed on the machine with nothing describing it — no removal replaying a \
         trace can ever reach it again"
    );
}

#[test]
fn a4_a_store_entry_a_line_this_build_cannot_read_may_designate_is_not_taken_away() {
    // GIVEN two things posed out of one materialisation, and a registry one of
    // whose lines has stopped reading — the state A1 grants its tolerance for,
    // and which is kept in the file **because** it describes something posed.
    //
    // A count taken over the lines that read answers "nothing else designates
    // it" and takes the materialisation away. What the illegible line described
    // then designates nothing, its bytes have left the machine, and no error was
    // reported.
    let machine = Machine::new("illegible-referent");
    let store = machine.store("acme-review-1.0");
    install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");
    install(
        &machine,
        "acme/review-too",
        &machine.root(),
        "review-too.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");

    let registry = machine.registry();
    let document = fs::read_to_string(registry.path()).expect("read the registry");
    fs::write(
        registry.path(),
        document.replace("acme/review-too", "acme/review\\qtoo"),
    )
    .expect("write a line carrying an escape this build does not know");
    let ledger = registry.read().expect("read the registry");
    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(
        ledger.unjudgeable().len(),
        1,
        "the fixture must be a line kept and not read, which is what the count has to reckon with"
    );

    // WHEN the one thing this build can still read is taken back off.
    uninstall(&machine, "acme/review").expect("the removal must succeed");

    // THEN the materialisation is still there, and what the illegible line
    // describes still resolves.
    assert!(
        store.exists(),
        "the materialisation was taken away while a line this build cannot read may still \
         designate it"
    );
    assert_eq!(
        fs::read_to_string(machine.root().join("review-too.md")).expect("the other link resolves"),
        ARTEFACT
    );
}

#[test]
fn guard_a_store_entry_nothing_else_designates_is_the_last_referent() {
    // The pair the guard above needs: a count that answered `Remaining` to
    // everything would pass it, and would keep every materialisation the
    // product ever made, for ever.
    let machine = Machine::new("last-referent");
    let store = machine.store("acme-review-1.0");
    install(
        &machine,
        "acme/review",
        &machine.root(),
        "review.md",
        "acme-review-1.0",
    )
    .expect("the pose and its record must succeed");

    let ledger = machine.registry().read().expect("read the registry");

    assert_eq!(
        ledger.referents(&store, &acme("acme/review")),
        Referents::Last
    );
}
