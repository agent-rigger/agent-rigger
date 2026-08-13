//! Which reading a removal decides on, and what it is then allowed to take
//! away.
//!
//! **Two requirements meet in this file, and they fail in the same direction**
//! — bytes an owner put somewhere, gone under cover of a removal, with the run
//! reporting success. The file is named for the first of them and now carries
//! both; the name is left as it is, because renaming it would move it in the
//! history to save a word, and this line does the same work for nothing.
//!
//! # B8 — a removal decides on what is at its address at the moment it acts
//!
//! Never on a state seized before the transaction started.
//!
//! **Both tests are born green, and that is why this header says how each was
//! made to go red.** The property is held today by the shape of the executor:
//! the `Unlink`, `Discard` and `Remove` arms each read their address again,
//! inside their own arm. Nothing in the type system holds that shape in place,
//! and the state the transaction seized is a local of `carry` — the very
//! function that drives the list. Handing it down spares every removal a read,
//! and this file is what has to notice.
//!
//! **An address can diverge from its capture in two directions, and one test
//! each.** The mutations below were applied to `carry` by hand and reverted.
//!
//! *Absent at the capture, carrying something when the removal comes.* This is
//! what a single list does when it poses and then takes back. The mutation:
//! skip any `Unlink`, `Discard` or `Remove` whose seized state is
//! `Seized::Absent`, on the reasoning that an address nothing was at has nothing
//! to take away. The mutated run leaves all three artefacts behind and reports
//! success.
//!
//! *Present at the capture, changed before the removal reaches it.* This is the
//! direction every real removal takes — `Link::undo` names the address it posed,
//! and that address exists — and it is the direction in which trusting the
//! capture looks free. The mutation: pass the seized state to the three arms and
//! believe it whenever it holds something, reading again only where it says
//! `Seized::Absent`. That is the patch somebody writes after the first mutation
//! above has gone red on them and they still want the reads back. Under it,
//! `Unlink` believes the `Link` the capture saw, never notices that the owner
//! has replaced the address with a document of their own, takes it away, and
//! reports success.
//!
//! **Which is why one assertion is on the disk and not on the return.** Under
//! the first mutation two arms would fail loudly — a removal that believed a
//! seized absence answers that the address is not as recorded. `Remove` would
//! not: absence is success for it, so it returns `Ok(())` and leaves the
//! artefact in the store. Only a reading of the machine tells that one apart
//! from a removal that worked.
//!
//! **What those two do not measure**, so that nobody reads more into them than
//! they hold: how much each pre-condition asks. They are about *which reading* a
//! removal acts on. An `Unlink` that still asked whether a link is there, but no
//! longer whether it designates what the trace recorded, leaves both of them
//! green — which is what the third test below is for.
//!
//! # The guard — a removal takes back what it posed, and nothing else
//!
//! A removal reaching an address that no longer carries what the trace recorded
//! leaves it alone and says so. What makes this worth a test of its own is that
//! the address is a place its owner may write: the product posed there, and the
//! owner has every right to put something else there afterwards. A removal that
//! only asked "is this the kind of thing I posed?" would answer yes to their
//! link and take it away.
//!
//! The mutation, applied to the `Unlink` arm by hand and reverted: match any
//! link at the address rather than one designating what the trace recorded.
//! Under it the owner's link is taken away and the run reports success.
//!
//! **Its counterpart for the shared store is measured elsewhere and is not
//! repeated here**: a pose by link makes the address a door into the store, so
//! what an owner writes at the address lands in the store entry, and taking that
//! entry away on the strength of nothing designating it any more would destroy
//! those bytes silently. The scenario for that one lives with the rollback
//! tests, and removing the fingerprint comparison from the `Remove` arm turns it
//! red — measured, not supposed.
//!
//! # MD-35 — the fingerprint the `Remove` arm compares against is measured, never handed to it
//!
//! The two guards above are about which *reading* a removal decides on; these
//! two are about where the fingerprint on the other side of that reading's
//! comparison can come from at all. [`rigger_apply::Measured`] is what the
//! `Remove` arm reads the address through, and its only constructor does the
//! `fs::read` itself — there is no way to hand it a [`rigger_plan::Digest`]
//! already in hand, one declared, or one read out of a registry line.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{
    carry, pose, withdraw, Measured, OnDisk, PoseError, StepError, Steps, SystemPracticability,
};
use rigger_plan::{behaviour, BehaviourName, Digest, Effect, Fragment, Placement, Referents};

/// The bytes of the artefact the scenarios pose.
const ARTEFACT: &str = "# Review\n\nRead the diff before the description.\n";

/// The bytes an owner leaves at an address of their own accord — what a removal
/// that decided on a stale reading would destroy.
const OWNED: &str = "# Review\n\nOur own checklist. Do not overwrite.\n";

/// A working directory holding the places a pose needs to exist already: the
/// root it writes under, the directory the artefacts land in, and the shared
/// store. The product makes none of them — a directory it created is a change no
/// removal takes away.
fn machine(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "rigger-removal-order-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(path.join("root/skills")).expect("create the root");
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

/// Everything under `base`, as bytes and as link targets — what the comparisons
/// below are made of.
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

#[test]
fn b8_a_removal_takes_away_what_the_steps_before_it_posed() {
    let machine = machine("posed-then-taken-back");
    let store = machine.join("store/acme-review-1.0");
    let linked = machine.join("root/skills/linked-review.md");
    let copied = machine.join("root/skills/copied-review.md");
    let before = snapshot(&machine);

    // One list, and the three kinds of removal are in it *after* the steps that
    // give them something to take away. The capture runs once, before the first
    // step, so all three addresses are seized absent — and absent is precisely
    // what none of them is when its own turn comes.
    let effects = [
        Effect::Materialise {
            address: store.clone(),
            contents: ARTEFACT.to_string(),
        },
        Effect::Link {
            address: linked.clone(),
            to: store.clone(),
        },
        Effect::Create {
            address: copied.clone(),
            contents: ARTEFACT.to_string(),
        },
        Effect::Unlink {
            address: linked,
            to: store.clone(),
        },
        Effect::Discard {
            address: copied,
            same_as: store.clone(),
        },
        Effect::Remove {
            address: store,
            posed: Digest::of(ARTEFACT.as_bytes()),
        },
    ];

    // The member of the closed set is not what is under measure here: it is the
    // one whose capture names every address a list of steps touches, so the list
    // above goes through without being refused for an address nothing seized.
    carry(behaviour(BehaviourName::Link), &effects, &OnDisk)
        .expect("every step of the list must be carried out");

    assert_eq!(
        snapshot(&machine),
        before,
        "each removal must take away what the steps before it posed; a run that reported success \
         and left the artefact behind is exactly what a removal reading the capture produces, and \
         the return alone cannot tell the two apart"
    );
}

/// Carries every step out on the real disk, and lets the owner of the root
/// replace what is at an address **in the window between the capture and the
/// step that reaches it**.
///
/// That window is why removals are conditioned at all. A capture is a reading,
/// and there is a moment after it in which the host — the one concurrent writer
/// the product can neither exclude nor foresee — rewrites its own files. Putting
/// that write at a chosen point of the sequence is the same choice the
/// interruption scenarios make, and for the same reason: a harness racing a real
/// writer would be green on broken code most times it ran.
struct OwnerReplacesBefore {
    /// The step, counted from zero, the owner's write lands in front of.
    step: usize,
    /// How many steps have been asked for so far.
    seen: Cell<usize>,
    /// The address they write at.
    at: PathBuf,
    /// What they leave there.
    contents: String,
}

impl Steps for OwnerReplacesBefore {
    fn carry_out(&self, effect: &Effect) -> Result<(), StepError> {
        let seen = self.seen.get();
        self.seen.set(seen + 1);
        if seen == self.step {
            // Whatever the product posed at this address, the owner's own
            // document is what is there now — and no reading taken before this
            // line can know it.
            let _ = fs::remove_file(&self.at);
            fs::write(&self.at, &self.contents).expect("the owner writes their own document");
        }
        OnDisk.carry_out(effect)
    }
}

#[test]
fn b8_a_removal_refuses_an_address_its_owner_changed_after_the_capture_read_it() {
    let machine = machine("owner-writes-in-the-window");
    let address = machine.join("root/skills/review.md");
    let store = machine.join("store/acme-review-1.0");

    let posted = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
        &SystemPracticability,
    )
    .expect("the pose the removal is about to take back");
    // What the capture is about to read: a link that is there, and a store entry
    // that is there. Every removal the product performs is in this direction —
    // it names the address it posed — so this is the state in which believing
    // the capture costs nothing visible, right up until something moves.
    let posed = snapshot(&machine);

    let owner = OwnerReplacesBefore {
        step: 0,
        seen: Cell::new(0),
        at: address.clone(),
        contents: OWNED.to_string(),
    };

    let failure = withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &owner,
    )
    .expect_err("the address no longer carries the link the trace recorded");

    match &failure {
        PoseError::RolledBack { step, failure } => {
            assert_eq!(*step, 0, "the removal of the address is the first step");
            match failure {
                StepError::NotAsRecorded { address: named, .. } => assert_eq!(
                    named, &address,
                    "the refusal must name the address that moved"
                ),
                other => panic!("expected the step to name what it did not recognise, got {other}"),
            }
        }
        other => panic!("expected a rolled-back removal, got {other}"),
    }
    assert_eq!(
        snapshot(&machine),
        posed,
        "a removal that believed the capture would have taken the owner's document away and \
         reported success; the run must refuse instead, and leave the machine as the capture \
         found it"
    );
}

/// The owner re-points the link, which needs a link made outside the product.
/// Restricted to the systems whose way of making one this test knows, exactly as
/// the pose is: the same restriction is already carried by the scenario that
/// poses onto a link in the conditioned-write tests.
#[cfg(unix)]
#[test]
fn guard_a_removal_leaves_alone_a_link_its_owner_repointed() {
    let machine = machine("owner-repoints-the-link");
    let address = machine.join("root/skills/review.md");
    let store = machine.join("store/acme-review-1.0");
    let theirs = machine.join("root/skills/their-own-checklist.md");

    let posted = pose(
        BehaviourName::Link,
        &address,
        &artefact(&store, Placement::Link),
        &OnDisk,
        &SystemPracticability,
    )
    .expect("the pose the removal is about to take back");

    // WHEN the owner makes the address designate a document of their own. They
    // are entitled to: the product posed at that address, it does not own it.
    // What is there is still a link, and still a link the product would know how
    // to take away — which is the whole difficulty.
    fs::write(&theirs, OWNED).expect("the owner writes their own document");
    fs::remove_file(&address).expect("the owner takes the posed link away");
    std::os::unix::fs::symlink(&theirs, &address).expect("the owner points it at their own");
    let repointed = snapshot(&machine);

    let failure = withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect_err("a removal took away a link the product had not posed");

    match &failure {
        PoseError::RolledBack { step, failure } => {
            assert_eq!(*step, 0, "the removal of the address is the first step");
            match failure {
                StepError::NotAsRecorded { address: named, .. } => assert_eq!(
                    named, &address,
                    "the refusal must name the address it left alone"
                ),
                other => panic!("expected the step to name what it did not recognise, got {other}"),
            }
        }
        other => panic!("expected a rolled-back removal, got {other}"),
    }
    assert_eq!(
        snapshot(&machine),
        repointed,
        "the product takes back what it posed and nothing else: a removal that asked only whether \
         a link is there would have taken the owner's away and reported success"
    );
}

#[test]
fn md35_a_measured_fingerprint_can_only_be_produced_by_reading_the_file() {
    // GIVEN a file of known content.
    let machine = machine("measured-known-content");
    let path = machine.join("root/skills/known.txt");
    let content = "known content, read once and hashed — nothing else could produce this value";
    fs::write(&path, content).expect("write the file of known content");

    // WHEN its fingerprint is measured.
    let measured = Measured::of(&path).expect("a file that is there must be measurable");

    // THEN it equals the fingerprint of the bytes it was written with. The only
    // way to obtain that equality is for `Measured::of` to have actually read
    // the file: a value that defaulted, or that echoed something handed to it,
    // would go red the day the content above changes and this assertion does
    // not move with it.
    assert_eq!(
        measured.digest(),
        Digest::of(content.as_bytes()),
        "the measured fingerprint does not match the content read from disk"
    );
}

#[test]
fn md35_a_missing_file_cannot_produce_a_measured_fingerprint() {
    // GIVEN a path nothing is at.
    let machine = machine("measured-missing-file");
    let path = machine.join("root/skills/absent.txt");

    // WHEN its fingerprint is measured.
    let failure = Measured::of(&path).expect_err("an absent file produced a fingerprint");

    // THEN the refusal names the path — never a default fingerprint standing in
    // for "nothing was there". That default is exactly the confusion MD-35
    // names: an empty content and an absent file are not the same state, and a
    // digest of zero bytes would make them read the same to every later
    // comparison.
    assert!(
        matches!(&failure, StepError::Io { address, .. } if *address == path),
        "the refusal does not name the path: {failure}"
    );
}
