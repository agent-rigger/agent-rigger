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
//! **What the sequence below is, and where it will live.** Reading the
//! registry, posing, recording, then replaying and unrecording is the order a
//! command carries out. The command surface is not built in this slice, so the
//! order is written here — and it is written once, in `install` and `uninstall`
//! below, rather than spread through the scenarios, so that the day it moves
//! into the command surface there is one place to read it from.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{pose, withdraw, OnDisk, SystemLiveness};
use rigger_plan::{replay, BehaviourName, Digest, Fragment, Placement, Referents};
use rigger_registry::{
    transact, Address, Consent, Decision, Entry, Identity, Ledger, Mutation, Outcome, Posting,
    Proposal, Registry, RegistryError, POSED_BY,
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
        },
        &OnDisk,
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
        trace: posted.record,
    });
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
    let name = BehaviourName::parse(entry.behaviour()).expect("the behaviour must resolve");
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
fn uninstall(machine: &Machine, id: &str) {
    let registry = machine.registry();
    let ledger: Ledger = registry.read().expect("read the registry");
    let entry = ledger
        .entries()
        .iter()
        .find(|entry| entry.id() == id)
        .expect("the registry must carry the entry");

    let name = BehaviourName::parse(entry.behaviour()).expect("the behaviour must resolve");
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
    uninstall(&machine, "acme/review");

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
    uninstall(&machine, "acme/review");

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
    uninstall(&machine, "acme/review");

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
    uninstall(&machine, "acme/review-too");

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
        format!("{document}entry\tacme/other\tacme\tlink\t1.4\t/home/someone\tother.md\tabc\n"),
    )
    .expect("write a line whose link trace has no placement");
    let ledger = registry.read().expect("read the registry");

    assert_eq!(
        ledger.referents(&store, &acme("acme/review")),
        Referents::Remaining,
        "an entry whose trace does not read back must not be counted as designating nothing"
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
    uninstall(&machine, "acme/review");

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
