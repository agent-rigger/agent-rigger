//! The closed set of behaviours, in scenarios.
//!
//! A test prefixed with an identifier realises that requirement. A4 — a rollback
//! gives back the state that preceded the transaction, and the quadruplet is
//! what makes that possible: a behaviour without its capture and its
//! restoration does not build, and that clause is realised by the doctests on
//! the `Behaviour` trait rather than here, because it is the **compiler** that
//! has to refuse. A5 — the set never shrinks in silence: a name it does not
//! contain is refused by naming it, never resolved to a neighbour.
//!
//! Those prefixed with `guard_` realise no requirement, and check that the
//! scenarios still measure something.

use std::path::{Path, PathBuf};

use rigger_grammar::{Edit, Grammar, Inverse, Jsonc, MergeError, Value};
use rigger_plan::{
    behaviour, BehaviourError, BehaviourName, Captured, Fragment, GrammarName, Restoration,
    Subject, Trace,
};

/// A settings document with hostile trivia: a tab indentation, and a comment on
/// a key the product does not touch. Restoring it means giving these bytes
/// back, all of them.
const DOCUMENT: &str = concat!(
    "{\n",
    "\t// the owner wrote this\n",
    "\t\"model\": \"opus\",\n",
    "\t\"theme\": \"dark\"\n",
    "}\n",
);

/// The address the scenarios act at. No file is at it and none needs to be:
/// this crate is pure, and what it is handed is what somebody else read.
fn address() -> PathBuf {
    Path::new("settings.json").to_path_buf()
}

/// An edit that adds one key the document does not carry.
fn edit() -> Edit {
    Edit::keys(&[], [("statusLine", Value::text("rigger"))])
}

/// The fragment a catalogue publishes for a merge on a named grammar.
fn fragment(grammar: GrammarName) -> Fragment {
    Fragment::Grammar {
        grammar,
        edit: edit(),
    }
}

#[test]
fn a4_the_closed_set_serves_every_member_it_names() {
    for member in BehaviourName::ALL {
        assert_eq!(
            behaviour(member).name(),
            member,
            "the set names `{member}` but does not serve it"
        );
    }
}

#[test]
fn guard_the_closed_set_has_exactly_four_members() {
    assert_eq!(BehaviourName::ALL.len(), 4);
    assert_eq!(
        BehaviourName::ALL
            .iter()
            .map(|member| member.as_str())
            .collect::<Vec<_>>(),
        vec!["link", "merge", "delegate", "probe"]
    );
}

#[test]
fn a5_a_behaviour_name_outside_the_closed_set_is_refused_by_naming_it() {
    let refusal = BehaviourName::parse("merge/legacy").expect_err("the set does not contain it");

    assert_eq!(
        refusal,
        BehaviourError::Unknown {
            named: "merge/legacy".to_string()
        },
        "the refusal must carry the name that was asked for, not merely fail"
    );
    assert!(
        refusal.to_string().contains("merge/legacy"),
        "a refusal that does not name what was asked leaves its reader searching: {refusal}"
    );
}

#[test]
fn a5_a_name_outside_the_set_is_never_resolved_to_a_neighbour() {
    // `merge` is in the set, and `merge/legacy` is not. Answering `merge`
    // because it resembles the name asked for is the recognition cascade that
    // ended in an undefined return — a thing posed that nothing could remove.
    assert!(BehaviourName::parse("merge").is_ok());
    assert!(BehaviourName::parse("merge/legacy").is_err());
    assert!(BehaviourName::parse("linked").is_err());
    assert!(BehaviourName::parse("").is_err());
}

#[test]
fn guard_every_member_of_the_closed_set_round_trips_through_its_name() {
    for member in BehaviourName::ALL {
        assert_eq!(BehaviourName::parse(member.as_str()), Ok(member));
    }
}

#[test]
fn a4_a_member_with_no_body_refuses_by_naming_itself_rather_than_leaving_a_hole() {
    let unbuilt = [
        BehaviourName::Link,
        BehaviourName::Delegate,
        BehaviourName::Probe,
    ];
    let subject = Subject {
        address: &address(),
        observed: Some(DOCUMENT),
    };
    let captured = Captured::Absent { address: address() };
    let trace = Trace::Grammar {
        grammar: GrammarName::Jsonc,
        inverse: Inverse::Keys {
            path: Vec::new(),
            added: Vec::new(),
            replaced: Vec::new(),
        },
    };

    for member in unbuilt {
        let served = behaviour(member);
        let expected = BehaviourError::NotBuilt { behaviour: member };

        // The four elements of the quadruplet, one by one: none of them
        // panics, none of them reports a success on a thing it did not do, and
        // each of them names the member — an unnamed refusal is the mode the
        // registry of failures records as a silent refusal.
        assert_eq!(
            served.pose(subject, &fragment(GrammarName::Jsonc)),
            Err(expected.clone())
        );
        assert_eq!(served.undo(subject, &trace), Err(expected.clone()));
        assert_eq!(served.capture(subject), Err(expected.clone()));
        assert_eq!(served.restore(&captured), Err(expected.clone()));
        assert!(
            expected.to_string().contains(member.as_str()),
            "the refusal of `{member}` must name it: {expected}"
        );
    }
}

#[test]
fn a4_merge_seizes_the_document_it_is_about_to_change_and_gives_it_back_whole() {
    let served = behaviour(BehaviourName::Merge);
    let subject = Subject {
        address: &address(),
        observed: Some(DOCUMENT),
    };

    let captured = served.capture(subject).expect("the capture must succeed");

    // The capture carries the bytes, not the fact that there were some. A
    // capture that recorded presence only would restore an absence, so an
    // update interrupted on an entry already present would give back nothing:
    // the disk would stay on the new version and the registry on the old one.
    assert_eq!(
        captured,
        Captured::Document {
            address: address(),
            contents: DOCUMENT.to_string(),
        }
    );
    assert_eq!(
        served
            .restore(&captured)
            .expect("the restoration must succeed"),
        Restoration::Write {
            address: address(),
            contents: DOCUMENT.to_string(),
        },
        "restoring an update must put the document from before back, byte for byte"
    );
}

#[test]
fn a4_merge_restores_the_absence_it_captured_when_there_was_no_document() {
    let served = behaviour(BehaviourName::Merge);
    let subject = Subject {
        address: &address(),
        observed: None,
    };

    let captured = served.capture(subject).expect("the capture must succeed");

    assert_eq!(captured, Captured::Absent { address: address() });
    assert_eq!(
        served
            .restore(&captured)
            .expect("the restoration must succeed"),
        Restoration::Remove { address: address() },
        "restoring a fresh pose must take away what was put there"
    );
}

#[test]
fn a4_the_capture_of_a_document_and_the_capture_of_an_absence_do_not_restore_alike() {
    // The two above, put side by side: a restoration that answered the same
    // thing to both would pass either of them alone. It is the pair that has
    // teeth, and this is where the pair is stated.
    let served = behaviour(BehaviourName::Merge);
    let present = served
        .capture(Subject {
            address: &address(),
            observed: Some(DOCUMENT),
        })
        .expect("the capture must succeed");
    let absent = served
        .capture(Subject {
            address: &address(),
            observed: None,
        })
        .expect("the capture must succeed");

    assert_ne!(served.restore(&present), served.restore(&absent));
}

#[test]
fn guard_merge_poses_through_its_grammar_and_its_trace_returns_the_document() {
    let served = behaviour(BehaviourName::Merge);
    let subject = Subject {
        address: &address(),
        observed: Some(DOCUMENT),
    };

    let posed = served
        .pose(subject, &fragment(GrammarName::Jsonc))
        .expect("the merge must succeed");
    assert!(posed.contents.contains("statusLine"));

    let undone = served
        .undo(
            Subject {
                address: &address(),
                observed: Some(&posed.contents),
            },
            &posed.trace,
        )
        .expect("the trace must run backwards");

    assert_eq!(
        undone.contents, DOCUMENT,
        "replaying the trace must return the document from before, byte for byte"
    );
}

#[test]
fn guard_merge_declared_on_a_read_only_grammar_is_refused_by_naming_it() {
    let served = behaviour(BehaviourName::Merge);
    let subject = Subject {
        address: &address(),
        observed: Some("model = \"opus\"\n"),
    };

    let refusal = served
        .pose(subject, &fragment(GrammarName::Toml))
        .expect_err("a read-only grammar is not admitted to `merge`");

    match refusal {
        BehaviourError::Merge(MergeError::NotAdmitted(reason)) => assert!(
            reason.to_string().contains("toml"),
            "the refusal must name the grammar: {reason}"
        ),
        other => panic!("expected a refusal from the admission gate, got {other}"),
    }
}

#[test]
fn guard_merge_into_nothing_is_refused_by_naming_the_address() {
    let served = behaviour(BehaviourName::Merge);
    let subject = Subject {
        address: &address(),
        observed: None,
    };

    let refusal = served
        .pose(subject, &fragment(GrammarName::Jsonc))
        .expect_err("there is no document to merge into");

    assert_eq!(
        refusal,
        BehaviourError::NoDocument {
            behaviour: BehaviourName::Merge,
            address: address(),
        }
    );
    assert!(refusal.to_string().contains("settings.json"));
}

#[test]
fn guard_the_document_the_scenarios_run_on_carries_the_trivia_they_claim() {
    // A watered-down document would make the restoration trivially true: giving
    // back bytes that carry no comment and no tab proves nothing about giving
    // back the ones that do.
    assert!(DOCUMENT.contains('\t'), "the document must be tab-indented");
    assert!(DOCUMENT.contains("//"), "the document must carry a comment");
    assert_eq!(
        Jsonc::round_trip(DOCUMENT).expect("the document must be readable"),
        DOCUMENT,
        "the document must be one the grammar returns unchanged"
    );
}
