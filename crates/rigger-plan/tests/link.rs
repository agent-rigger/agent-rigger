//! The pose by link, as values.
//!
//! A test prefixed with an identifier realises that requirement. A4 — an
//! interrupted transaction gives back the state that preceded it, and the half
//! of that which this crate carries is the shape of the steps: the store entry
//! is materialised before it is designated, and taken away in a step of the
//! same list as everything else. A5 — the set never shrinks in silence, and a
//! trace that names a behaviour or a placement this build did not write is
//! refused by naming it, never guessed.
//!
//! Those prefixed with `guard_` realise no requirement of family A or C: the
//! behaviour's own family is not written yet. They state what the tracer bullet
//! relies on, so that a later requirement finds them rather than an empty file.
//!
//! **This crate is pure, so nothing here touches a disk.** What is measured is
//! the decision — which steps, in which order, with which conditions — and the
//! carrying out lives where the input and output do.

use std::path::{Path, PathBuf};

use rigger_grammar::{Edit, Inverse, Value};
use rigger_plan::{
    behaviour, record, replay, Behaviour, BehaviourError, BehaviourName, Digest, Effect, Fragment,
    GrammarName, Placement, Referents, Subject, Trace,
};

/// The bytes of the artefact the scenarios pose.
const ARTEFACT: &str = "# Review\n\nRead the diff before the description.\n";

fn address() -> PathBuf {
    PathBuf::from("/home/someone/.claude/skills/review.md")
}

fn store() -> PathBuf {
    PathBuf::from("/home/someone/.rigger/store/acme-review-1.0")
}

/// The fingerprint of the bytes the scenarios materialise — what the removal of
/// the store entry is conditioned on.
fn materialised() -> Digest {
    Digest::of(ARTEFACT.as_bytes())
}

fn artefact(placement: Placement) -> Fragment {
    Fragment::Artefact {
        store: store(),
        contents: ARTEFACT.to_string(),
        placement,
    }
}

fn subject(address: &Path) -> Subject<'_> {
    Subject {
        address,
        observed: None,
    }
}

fn link() -> &'static dyn Behaviour {
    behaviour(BehaviourName::Link)
}

#[test]
fn guard_a_pose_materialises_the_artefact_once_and_then_designates_it() {
    let posed = link()
        .pose(subject(&address()), &artefact(Placement::Link))
        .expect("the pose must succeed");

    assert_eq!(
        posed.effects,
        vec![
            Effect::Materialise {
                address: store(),
                contents: ARTEFACT.to_string(),
            },
            Effect::Link {
                address: address(),
                to: store(),
            },
        ],
        "the store entry must be materialised before anything designates it: the reverse order \
         would leave, for an instant and for good if the rollback then failed, a link on the \
         machine pointing at nothing"
    );
    assert_eq!(
        posed.trace,
        Trace::Link {
            store: store(),
            placement: Placement::Link,
            posed: materialised(),
        }
    );
}

#[test]
fn guard_a_pose_by_copy_records_that_it_was_a_copy_and_still_materialises_the_store_entry() {
    let posed = link()
        .pose(subject(&address()), &artefact(Placement::Copy))
        .expect("the pose must succeed");

    assert_eq!(
        posed.effects,
        vec![
            // The store entry is materialised either way, and counted either
            // way: a machine that cannot make links still shares one
            // materialisation, and its removal answers the same question.
            Effect::Materialise {
                address: store(),
                contents: ARTEFACT.to_string(),
            },
            Effect::Create {
                address: address(),
                contents: ARTEFACT.to_string(),
            },
        ]
    );
    assert_eq!(
        posed.trace,
        Trace::Link {
            store: store(),
            placement: Placement::Copy,
            posed: materialised(),
        },
        "the trace must say which of the two was done — without it a removal facing an ordinary \
         file cannot tell a copy this product posed from a document somebody wrote, and the only \
         way left to decide would be to recognise the shape of what is on disk"
    );
}

#[test]
fn guard_the_two_placements_are_undone_by_two_different_conditions() {
    // What the placement in the trace is *for*. A removal that answered the
    // same step to both would make recording it pointless, and the field would
    // be decoration.
    let by_link = link()
        .undo(
            subject(&address()),
            &Trace::Link {
                store: store(),
                placement: Placement::Link,
                posed: materialised(),
            },
            Referents::Remaining,
        )
        .expect("the removal must be computable");
    let by_copy = link()
        .undo(
            subject(&address()),
            &Trace::Link {
                store: store(),
                placement: Placement::Copy,
                posed: materialised(),
            },
            Referents::Remaining,
        )
        .expect("the removal must be computable");

    assert_eq!(
        by_link.effects,
        vec![Effect::Unlink {
            address: address(),
            to: store(),
        }]
    );
    assert_eq!(
        by_copy.effects,
        vec![Effect::Discard {
            address: address(),
            same_as: store(),
        }]
    );
    assert_ne!(by_link.effects, by_copy.effects);
}

#[test]
fn a4_the_store_entry_is_taken_away_at_the_last_referent_and_never_before() {
    let trace = Trace::Link {
        store: store(),
        placement: Placement::Link,
        posed: materialised(),
    };

    let while_shared = link()
        .undo(subject(&address()), &trace, Referents::Remaining)
        .expect("the removal must be computable");
    let last = link()
        .undo(subject(&address()), &trace, Referents::Last)
        .expect("the removal must be computable");

    assert_eq!(
        while_shared.effects.len(),
        1,
        "the store entry must stay while anything else designates it: taking it away leaves those \
         links pointing at nothing"
    );
    assert_eq!(
        last.effects,
        vec![
            Effect::Unlink {
                address: address(),
                to: store(),
            },
            // In the same list as the rest, so the transaction seizes it before
            // it goes and gives it back if a later step fails. A direct path
            // deleting as soon as a count reached zero would leave a rollback
            // with nothing to give back, and no test added afterwards recovers
            // that.
            Effect::Remove {
                address: store(),
                posed: materialised(),
            },
        ],
        "the address must be taken back before the store entry it designated"
    );
}

#[test]
fn guard_a_removal_is_computed_from_the_trace_and_from_nothing_that_is_on_the_machine() {
    // The subject carries no reading at all, and the removal is still whole.
    // That is the decision the model rests on: the archived implementation
    // ended its recognition of shapes on a return that said nothing, which made
    // a posed thing unremovable with no error at all.
    let from_nothing = link()
        .undo(
            Subject {
                address: &address(),
                observed: None,
            },
            &Trace::Link {
                store: store(),
                placement: Placement::Copy,
                posed: materialised(),
            },
            Referents::Last,
        )
        .expect("a removal must not need the machine to be readable");

    assert_eq!(
        from_nothing.effects.first(),
        Some(&Effect::Discard {
            address: address(),
            same_as: store(),
        })
    );
}

#[test]
fn a5_a_recorded_trace_reads_back_as_the_one_that_was_written() {
    let posed = link()
        .pose(subject(&address()), &artefact(Placement::Copy))
        .expect("the pose must succeed");

    let fields = record(&posed.trace).expect("a link trace must be recordable");
    let read_back = replay(BehaviourName::Link, &fields).expect("it must read back");

    assert_eq!(read_back, posed.trace);
    assert_eq!(
        fields,
        vec![
            store().display().to_string(),
            "copy".to_string(),
            materialised().to_string(),
        ]
    );
}

#[test]
fn a5_a_placement_this_build_did_not_write_is_refused_rather_than_guessed() {
    let refusal = replay(
        BehaviourName::Link,
        &[
            store().display().to_string(),
            "hardlink".to_string(),
            materialised().to_string(),
        ],
    )
    .expect_err("a placement outside the two was read as one of them");

    match &refusal {
        BehaviourError::TraceUnreadable { behaviour, reason } => {
            assert_eq!(*behaviour, BehaviourName::Link);
            assert!(
                reason.contains("hardlink"),
                "the refusal must name what it could not read: {reason}"
            );
        }
        other => panic!("expected an unreadable trace, got {other}"),
    }
}

#[test]
fn a5_a_trace_of_the_wrong_arity_is_refused_rather_than_padded() {
    let refusal = replay(
        BehaviourName::Link,
        &[store().display().to_string(), "link".to_string()],
    )
    .expect_err("a trace missing its fingerprint was read all the same");

    assert!(
        matches!(refusal, BehaviourError::TraceUnreadable { .. }),
        "a missing field must be a refusal and never a default: a guessed placement undoes \
         something other than what was posed"
    );
}

#[test]
fn a5_a_fingerprint_this_build_did_not_write_is_refused_rather_than_guessed() {
    // The removal of the store entry is conditioned on this field. Read
    // loosely — padded, or taken for a default — it would condition the removal
    // on nothing, and the bytes an owner wrote through the link would be taken
    // away as if they were the ones the product materialised.
    let refusal = replay(
        BehaviourName::Link,
        &[
            store().display().to_string(),
            "link".to_string(),
            "not a fingerprint".to_string(),
        ],
    )
    .expect_err("a field that is not a fingerprint was read as one");

    match &refusal {
        BehaviourError::TraceUnreadable { behaviour, reason } => {
            assert_eq!(*behaviour, BehaviourName::Link);
            assert!(
                reason.contains("not a fingerprint"),
                "the refusal must name what it could not read: {reason}"
            );
        }
        other => panic!("expected an unreadable trace, got {other}"),
    }
}

#[test]
fn guard_the_removal_of_the_store_entry_carries_the_fingerprint_the_pose_recorded() {
    // The pair the two refusals above need: a `replay` that refused every
    // fingerprint would pass them both, and no removal would ever compute the
    // step that takes a store entry away.
    let posed_now = link()
        .pose(subject(&address()), &artefact(Placement::Link))
        .expect("the pose must succeed");
    let fields = record(&posed_now.trace).expect("a link trace must be recordable");
    let read_back = replay(BehaviourName::Link, &fields).expect("it must read back");

    let undone = link()
        .undo(subject(&address()), &read_back, Referents::Last)
        .expect("the removal must be computable");

    assert_eq!(
        undone.effects.last(),
        Some(&Effect::Remove {
            address: store(),
            posed: posed_now.fingerprint,
        }),
        "the step that takes the materialisation away must carry the fingerprint of what was \
         materialised, so that bytes somebody else wrote through the link are left alone"
    );
}

#[test]
fn a4_a_pose_whose_trace_the_registry_cannot_hold_is_refused_before_it_happens() {
    // A merge is computed and undone in memory, and the slice that puts its
    // inverse in the registry is not this one. The refusal is what keeps that
    // from becoming a thing posed that nothing can ever remove: it is asked for
    // before anything is carried out.
    let refusal = record(&Trace::Grammar {
        grammar: GrammarName::Jsonc,
        inverse: Inverse::Keys {
            path: Vec::new(),
            added: vec!["statusLine".to_string()],
            replaced: Vec::new(),
        },
    })
    .expect_err("a trace this build cannot record was recorded all the same");

    assert_eq!(
        refusal,
        BehaviourError::NotRecordable {
            behaviour: BehaviourName::Merge,
        }
    );
    assert!(refusal.to_string().contains("merge"));
}

#[test]
fn guard_a_fragment_of_another_shape_is_refused_by_naming_what_the_member_serves() {
    let refusal = link()
        .pose(
            subject(&address()),
            &Fragment::Grammar {
                grammar: GrammarName::Jsonc,
                edit: Edit::keys(&[], [("statusLine", Value::text("rigger"))]),
            },
        )
        .expect_err("a grammar fragment was posed by link");

    match refusal {
        BehaviourError::WrongShape { behaviour, serves } => {
            assert_eq!(behaviour, BehaviourName::Link);
            assert!(serves.contains("store"));
        }
        other => panic!("expected a refusal naming what the member serves, got {other}"),
    }
}

#[test]
fn guard_the_fingerprint_is_the_one_of_the_bytes_that_were_posed() {
    let posed = link()
        .pose(subject(&address()), &artefact(Placement::Link))
        .expect("the pose must succeed");

    assert_eq!(posed.fingerprint, Digest::of(ARTEFACT.as_bytes()));
    assert_ne!(
        posed.fingerprint,
        Digest::of(format!("{ARTEFACT}\n").as_bytes())
    );
}

#[test]
fn guard_the_fingerprint_keeps_the_values_this_build_recorded() {
    // Pinned, and that is the whole point of pinning them. What the registry
    // holds has to read back the same under every later build: a fingerprint
    // whose algorithm moved would report every entry on a machine as rewritten
    // by somebody else, on the day the product was updated. These are the
    // published values of FNV-1a over 64 bits, so this goes red on a change of
    // algorithm and not merely on a change of implementation.
    assert_eq!(Digest::of(b"").to_string(), "cbf29ce484222325");
    assert_eq!(Digest::of(b"a").to_string(), "af63dc4c8601ec8c");
    assert_eq!(Digest::of(b"foobar").to_string(), "85944171f73967e8");
}
