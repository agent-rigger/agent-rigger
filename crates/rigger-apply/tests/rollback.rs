//! A4 — an interrupted transaction gives back the state that preceded it.
//!
//! A test prefixed with an identifier realises that requirement. Those prefixed
//! with `guard_` realise none: they state what the transaction relies on, and
//! they are what keeps the ones above from passing on a transaction that
//! refuses everything.
//!
//! **The interruption is a point of the sequence, not a killed process.** What
//! the requirement asks is that a failure *after* the materialisation and
//! *before* the record give the machine back — and that is a place in a list of
//! steps. A harness that killed a process would have to hit a window nothing
//! deterministic schedules, and would be green on broken code most times it ran.
//! The failing executor below carries each step out on the real disk and then
//! reports the chosen one failed, which puts the failure exactly where it hurts:
//! after the change landed.

use std::cell::Cell;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rigger_apply::{carry, pose, withdraw, OnDisk, PoseError, StepError, Steps};
use rigger_plan::{
    behaviour, Behaviour, BehaviourError, BehaviourName, Captured, Effect, Fragment, Placement,
    Posed, Referents, Restoration, Subject, Trace, Undone,
};

/// The bytes of the artefact the scenarios pose.
const ARTEFACT: &str = "# Review\n\nRead the diff before the description.\n";

/// A working directory holding the two places a pose needs to exist already:
/// the root it writes under, and the shared store. The product makes neither —
/// a directory it created is a change no removal takes away.
fn machine(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-rollback-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(path.join("root")).expect("create the root");
    fs::create_dir_all(path.join("store")).expect("create the shared store");
    path
}

fn artefact(store: &Path, placement: Placement) -> Fragment {
    Fragment::Artefact {
        store: store.to_path_buf(),
        contents: ARTEFACT.to_string(),
        placement,
    }
}

/// Everything under `base`, as bytes and as link targets — the comparison "the
/// machine is as it was" is made of.
fn snapshot(base: &Path) -> Vec<(String, String)> {
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

    let mut found = Vec::new();
    walk(base, base, &mut found);
    found
}

/// Carries every step out on the real disk, and reports the chosen one failed
/// **after** it landed.
///
/// That is what an interruption looks like from inside a transaction: the change
/// is on the machine and the run does not get to the next one. Reporting the
/// failure *before* carrying it out would measure something easier — a
/// transaction that never changed anything has nothing to give back.
struct FailsAfter {
    step: usize,
    seen: Cell<usize>,
    failed: Cell<bool>,
    refuses_to_restore: bool,
}

impl FailsAfter {
    fn step(step: usize) -> Self {
        Self {
            step,
            seen: Cell::new(0),
            failed: Cell::new(false),
            refuses_to_restore: false,
        }
    }

    /// The same, and the restoration fails too — the scenario in which capture
    /// and restoration are two distinct invariants and only the second is
    /// broken.
    fn and_the_restoration(mut self) -> Self {
        self.refuses_to_restore = true;
        self
    }
}

impl Steps for FailsAfter {
    fn carry_out(&self, effect: &Effect) -> Result<(), StepError> {
        if self.failed.get() {
            if self.refuses_to_restore {
                return Err(StepError::Io {
                    address: effect.address().to_path_buf(),
                    detail: io::Error::other("the restoration was refused, for this scenario"),
                });
            }
            return OnDisk.carry_out(effect);
        }
        let seen = self.seen.get();
        self.seen.set(seen + 1);
        OnDisk.carry_out(effect)?;
        if seen == self.step {
            self.failed.set(true);
            return Err(StepError::Io {
                address: effect.address().to_path_buf(),
                detail: io::Error::other("the run was interrupted here, for this scenario"),
            });
        }
        Ok(())
    }
}

#[test]
fn a4_an_interrupted_pose_gives_the_machine_back_the_state_it_was_in() {
    let machine = machine("interrupted-pose");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");
    let before = snapshot(&machine);

    // WHEN the run is interrupted after the artefact has been materialised and
    // the link made — that is, after both changes have landed.
    let failure = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &FailsAfter::step(1),
    )
    .expect_err("an interrupted pose reported success");

    match &failure {
        PoseError::RolledBack { step, .. } => assert_eq!(*step, 1),
        other => panic!("expected a rolled back transaction, got {other}"),
    }
    assert_eq!(
        snapshot(&machine),
        before,
        "the machine must be what it was, and that includes the shared store"
    );
}

#[test]
fn a4_a_rollback_gives_back_a_shared_store_entry_the_transaction_had_removed() {
    // GIVEN a store entry that has lost its last referent, and a removal that
    // fails after taking it away. This is the failure a compensation written
    // per kind of operation never covered: its table knew how to undo a write
    // to a file at a path, and the removal of a store entry is not one.
    let machine = machine("store-rollback");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");
    let posted = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect("the pose must succeed");
    let posed = snapshot(&machine);

    let failure = withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &FailsAfter::step(1),
    )
    .expect_err("an interrupted removal reported success");

    match &failure {
        PoseError::RolledBack { step, .. } => assert_eq!(*step, 1),
        other => panic!("expected a rolled back transaction, got {other}"),
    }
    assert_eq!(
        fs::read_to_string(&store).expect("the store entry must be back"),
        ARTEFACT,
        "the materialisation must be given back with its bytes, and not merely recreated empty"
    );
    assert_eq!(
        fs::read_to_string(&address).expect("the link must resolve"),
        ARTEFACT,
        "no link on the machine may designate something that is not there"
    );
    assert_eq!(snapshot(&machine), posed);
}

#[test]
fn a4_a_failed_restoration_names_the_restoration_and_keeps_the_state_it_seized() {
    // Capture and restoration are two distinct invariants. Folded into one
    // failure, this reader could not tell a machine whose state was never taken
    // from one whose state is taken and waiting for a second try.
    let machine = machine("failed-restoration");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");

    let failure = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &FailsAfter::step(0).and_the_restoration(),
    )
    .expect_err("a pose whose restoration failed reported success");

    match &failure {
        PoseError::NotRestored { step, .. } => assert_eq!(*step, 0),
        other => panic!("expected a failure naming the restoration, got {other}"),
    }
    let held = failure
        .captured()
        .expect("the seized state must stay available for a second try");
    assert!(
        held.holds(&store) && held.holds(&address),
        "the state that was seized is what a resumption needs, and it is what the failure carries"
    );
    let said = failure.to_string();
    assert!(
        said.contains("restoration"),
        "the failure must name the restoration rather than the capture: {said}"
    );
}

/// A behaviour that changes an address its capture never named.
///
/// It is declared here and not in the crate because the closed set cannot be
/// added to — which is the point of the set. The transaction takes a behaviour,
/// so the guard can be exercised without opening anything.
struct UnderDeclaring {
    changes: PathBuf,
}

impl Behaviour for UnderDeclaring {
    fn name(&self) -> BehaviourName {
        BehaviourName::Link
    }

    fn pose(&self, _: Subject<'_>, _: &Fragment) -> Result<Posed, BehaviourError> {
        Err(BehaviourError::NotBuilt {
            behaviour: self.name(),
        })
    }

    fn undo(&self, _: Subject<'_>, _: &Trace, _: Referents) -> Result<Undone, BehaviourError> {
        Err(BehaviourError::NotBuilt {
            behaviour: self.name(),
        })
    }

    fn capture(&self, _effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError> {
        // It names nothing, and it is about to change `changes`.
        Ok(Vec::new())
    }

    fn restore(&self, _: &Captured) -> Result<Restoration, BehaviourError> {
        Ok(Restoration {
            effects: Vec::new(),
        })
    }
}

#[test]
fn a4_a_step_touching_an_address_the_capture_did_not_name_is_refused_before_anything_changes() {
    let machine = machine("under-declared");
    let address = machine.join("root/review.md");
    let before = snapshot(&machine);
    let served = UnderDeclaring {
        changes: address.clone(),
    };

    let failure = carry(
        &served,
        &[Effect::Create {
            address: served.changes.clone(),
            contents: ARTEFACT.to_string(),
        }],
        &OnDisk,
    )
    .expect_err("a step changed an address nothing had seized");

    match &failure {
        PoseError::Undeclared {
            behaviour, address, ..
        } => {
            assert_eq!(*behaviour, BehaviourName::Link);
            assert_eq!(address, &served.changes);
        }
        other => panic!("expected a refusal naming the address, got {other}"),
    }
    assert_eq!(
        snapshot(&machine),
        before,
        "nothing must be carried out: a rollback would have had nothing to give back there"
    );
}

#[test]
fn guard_the_nominal_pose_and_removal_go_through_the_implementation_the_product_uses() {
    // The pair the scenarios above need. A transaction that refused everything
    // would pass every one of them, and would pose nothing on any machine — and
    // the failing executor is a seam, so a path the production one does not go
    // through would be code nobody measures.
    let machine = machine("nominal");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");
    let before = snapshot(&machine);

    let posted = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect("the nominal pose must succeed");

    assert_eq!(
        fs::read_to_string(&address).expect("the link resolves"),
        ARTEFACT
    );
    assert!(
        fs::symlink_metadata(&address)
            .expect("the address exists")
            .file_type()
            .is_symlink(),
        "a pose declared as a link must leave a link"
    );

    withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect("the nominal removal must succeed");

    assert_eq!(snapshot(&machine), before);
}

#[test]
fn guard_a_pose_onto_an_occupied_address_refuses_and_leaves_what_is_there_alone() {
    let machine = machine("occupied");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");
    fs::write(&address, "what its owner wrote\n").expect("write the owner's file");
    let before = snapshot(&machine);

    let failure = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect_err("a pose wrote over a file the product had not put there");

    assert!(
        failure.to_string().contains("review.md"),
        "the refusal must name the address: {failure}"
    );
    assert_eq!(
        snapshot(&machine),
        before,
        "what its owner wrote must be exactly as it was, and the materialisation given back"
    );
}

#[test]
fn guard_a_store_entry_holding_other_bytes_is_refused_rather_than_written_over() {
    // One store entry standing for two different contents is the one state a
    // shared store must never reach: every address designating it would get
    // whichever of the two was written last.
    let machine = machine("store-conflict");
    let store = machine.join("store/acme-review-1.0");
    fs::write(&store, "other bytes\n").expect("write the store entry");
    let before = snapshot(&machine);

    let failure = pose(
        BehaviourName::Link,
        &machine.join("root/review.md"),
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect_err("a store entry was written over");

    assert!(
        failure.to_string().contains("acme-review-1.0"),
        "the refusal must name the store entry: {failure}"
    );
    assert_eq!(snapshot(&machine), before);
}

#[test]
fn a4_a_pose_whose_trace_the_registry_could_not_hold_never_touches_the_machine() {
    // A pose recorded by nothing is a thing permanently unremovable, and that is
    // worse than a refusal because nobody sees it. So the trace is put in the
    // form the registry writes **before** anything changes: asking for it
    // afterwards would leave the document written and the failure reported, with
    // no record of what to undo.
    let machine = machine("unrecordable");
    let address = machine.join("root/settings.json");
    fs::write(&address, "{\n\t\"model\": \"opus\"\n}\n").expect("write the document");
    let before = snapshot(&machine);

    let failure = pose(
        BehaviourName::Merge,
        &address,
        &Fragment::Grammar {
            grammar: rigger_plan::GrammarName::Jsonc,
            edit: rigger_grammar::Edit::keys(
                &[],
                [("statusLine", rigger_grammar::Value::text("rigger"))],
            ),
        },
        &OnDisk,
    )
    .expect_err("a pose the registry could not describe went through");

    match &failure {
        PoseError::Refused(BehaviourError::NotRecordable { behaviour }) => {
            assert_eq!(*behaviour, BehaviourName::Merge)
        }
        other => panic!("expected a refusal naming what cannot be recorded, got {other}"),
    }
    assert_eq!(
        snapshot(&machine),
        before,
        "the document must be exactly what it was, byte for byte"
    );
}

#[test]
fn guard_a_removal_leaves_alone_what_the_trace_does_not_describe() {
    // The owner replaced what was posed with something of their own. The trace
    // says a link designating the store entry is there; it is not, so the
    // product takes nothing away.
    let machine = machine("not-as-recorded");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");
    let posted = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect("the pose must succeed");
    fs::remove_file(&address).expect("take the link away");
    fs::write(&address, "what its owner wrote instead\n").expect("write the owner's file");
    let before = snapshot(&machine);

    let failure = withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect_err("a removal took away something the product had not posed");

    assert!(
        failure.to_string().contains("review.md"),
        "the refusal must name the address: {failure}"
    );
    assert_eq!(
        snapshot(&machine),
        before,
        "the product takes back what it posed and nothing else"
    );
}

#[test]
fn guard_a_pose_by_copy_and_its_removal_leave_the_machine_as_it_was() {
    // The other placement, on a real disk. Both take the store entry away at the
    // last referent and both condition that on the bytes materialised there, so
    // a condition written for one of them has to be exercised through the other
    // as well — the copy path has no test of its own anywhere else.
    let machine = machine("by-copy");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");
    let before = snapshot(&machine);

    let posted = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Copy),
        &OnDisk,
    )
    .expect("the pose must succeed");

    assert!(
        !fs::symlink_metadata(&address)
            .expect("the address exists")
            .file_type()
            .is_symlink(),
        "a pose declared as a copy must leave a copy"
    );
    assert_eq!(
        fs::read_to_string(&address).expect("read the copy"),
        ARTEFACT
    );

    withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect("the removal must succeed");

    assert_eq!(snapshot(&machine), before);
}

#[test]
fn guard_a_removal_leaves_alone_a_store_entry_carrying_bytes_that_are_not_the_ones_posed() {
    // A pose by link makes the address a door into the shared store: what its
    // owner writes at the address travels through the link and lands in the
    // store entry itself. Taking that entry away because nothing designates it
    // any more would destroy those bytes, silently, and report success.
    //
    // The same gesture posed by copy already refuses — the removal compares what
    // is at the address against the materialisation before taking it away. The
    // two placements must answer the owner's gesture the same way.
    let machine = machine("store-rewritten");
    let address = machine.join("root/review.md");
    let store = machine.join("store/acme-review-1.0");
    let posted = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect("the pose must succeed");

    // WHEN its owner writes through the address the pose gave them.
    fs::write(&address, "notes its owner wrote\n").expect("write through the link");
    let before = snapshot(&machine);

    let failure = withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect_err("a removal took away bytes the product had not written");

    assert!(
        failure.to_string().contains("acme-review-1.0"),
        "the refusal must name the store entry it left alone: {failure}"
    );
    assert_eq!(
        snapshot(&machine),
        before,
        "the product takes back what it posed and nothing else, in the store as at the address"
    );
}

#[test]
fn a4_a_rollback_leaves_alone_an_address_whose_seized_state_is_still_there() {
    // GIVEN one artefact already materialised and designated, and a second pose
    // of the same artefact — which materialises nothing, the store entry being
    // there with those very bytes, and only designates it from a second address.
    //
    // The store entry is in the capture all the same, because a step of this
    // transaction names it. Giving it back by taking it away and writing it
    // again would, for an instant, remove a materialisation the first pose still
    // designates — and destroy it outright if the second half failed, which is
    // likely, the run having already failed once.
    let machine = machine("untouched-address");
    let store = machine.join("store/acme-review-1.0");
    let first = machine.join("root/review.md");
    pose(
        BehaviourName::Link,
        &first,
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect("the first pose must succeed");

    // A second name for the very same file. Writing through it later is what
    // tells a store entry left alone from one taken away and written again with
    // the same bytes — the two are indistinguishable by their contents, and this
    // is the difference the failure would destroy.
    let witness = machine.join("witness");
    fs::hard_link(&store, &witness).expect("name the store entry a second time");
    let posed = snapshot(&machine);

    // WHEN the second pose is interrupted after its link has landed.
    let failure = pose(
        BehaviourName::Link,
        &machine.join("root/review-too.md"),
        &artefact(&store, Placement::Link),
        &FailsAfter::step(1),
    )
    .expect_err("an interrupted pose reported success");

    match &failure {
        PoseError::RolledBack { step, .. } => assert_eq!(*step, 1),
        other => panic!("expected a rolled back transaction, got {other}"),
    }
    assert_eq!(snapshot(&machine), posed);

    // THEN the store entry is the file the first pose materialised, and not one
    // written in its place.
    fs::write(&witness, "written through the other name\n").expect("write through the witness");
    assert_eq!(
        fs::read_to_string(&store).expect("read the store entry"),
        "written through the other name\n",
        "the rollback took away and rewrote a store entry no step of it had changed, leaving the \
         pose that had completed designating a different file"
    );
}

#[test]
fn a4_a_rollback_gives_back_the_document_a_write_replaced_through_a_link() {
    // GIVEN an address that is a symbolic link into a document its owner keeps
    // elsewhere — a settings file linked into a versioned configuration
    // repository, which is what that kind of repository is for.
    //
    // A conditional write renames onto the **document**, never onto the link:
    // renaming onto the link would replace it with an ordinary file and the real
    // document would never receive the pose. So the state a rollback has to give
    // back is the document's, and seizing the link alone gives back something no
    // step ever changed while the owner's document keeps what was merged into it.
    let machine = machine("write-through-a-link");
    let document = machine.join("store/settings.json");
    let address = machine.join("root/settings.json");
    const OWNED: &str = "{\n\t\"model\": \"opus\"\n}\n";
    const MERGED: &str = "{\n\t\"model\": \"opus\",\n\t\"statusLine\": \"rigger\"\n}\n";
    fs::write(&document, OWNED).expect("write the owner's document");
    OnDisk
        .carry_out(&Effect::Link {
            address: address.clone(),
            to: document.clone(),
        })
        .expect("make the link");
    let before = snapshot(&machine);

    // WHEN a write through that address lands and the run fails there.
    let failure = carry(
        behaviour(BehaviourName::Merge),
        &[Effect::Write {
            address: address.clone(),
            contents: MERGED.to_string(),
            expected: OWNED.to_string(),
        }],
        &FailsAfter::step(0),
    )
    .expect_err("an interrupted write reported success");

    match &failure {
        PoseError::RolledBack { step, .. } => assert_eq!(*step, 0),
        other => panic!("expected a rolled back transaction, got {other}"),
    }
    assert_eq!(
        fs::read_to_string(&document).expect("read the owner's document"),
        OWNED,
        "the rollback gave back the link, which nothing had changed, and left the document its \
         owner keeps carrying what the interrupted run had merged into it"
    );
    assert_eq!(snapshot(&machine), before);
}

#[test]
fn guard_a_pose_into_a_directory_that_is_not_there_refuses_by_naming_it() {
    // The product makes no directory: one it created would be a change the
    // capture would have to seize and the restoration give back, and this
    // version builds neither.
    let machine = machine("no-directory");
    let address = machine.join("root/skills/review.md");
    let store = machine.join("store/acme-review-1.0");
    let before = snapshot(&machine);

    let failure = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
    )
    .expect_err("a pose made a directory nothing would take away");

    assert!(
        failure.to_string().contains("skills"),
        "the refusal must name the directory that is not there: {failure}"
    );
    assert_eq!(snapshot(&machine), before);
}

#[test]
fn guard_the_behaviour_the_scenarios_run_through_is_the_one_the_closed_set_serves() {
    // Without this, every scenario above could be running through something the
    // catalogue can never select.
    assert_eq!(behaviour(BehaviourName::Link).name(), BehaviourName::Link);
}
