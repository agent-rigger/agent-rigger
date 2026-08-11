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
    behaviour, BehaviourError, BehaviourName, Captured, Effect, Fragment, GrammarName, Referents,
    Restoration, Seized, Subject, Trace,
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
    let unbuilt = [BehaviourName::Delegate, BehaviourName::Probe];
    let subject = Subject {
        address: &address(),
        observed: Some(DOCUMENT),
    };
    let captured = Captured::of(vec![Seized::Absent { address: address() }]);
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
        assert_eq!(
            served.undo(subject, &trace, Referents::Last),
            Err(expected.clone())
        );
        assert_eq!(served.capture(&[]), Err(expected.clone()));
        assert_eq!(served.restore(&captured), Err(expected.clone()));
        assert!(
            expected.to_string().contains(member.as_str()),
            "the refusal of `{member}` must name it: {expected}"
        );
    }
}

#[test]
fn a4_merge_names_the_document_it_is_about_to_change() {
    let served = behaviour(BehaviourName::Merge);
    let subject = Subject {
        address: &address(),
        observed: Some(DOCUMENT),
    };

    let posed = served
        .pose(subject, &fragment(GrammarName::Jsonc))
        .expect("the pose must succeed");

    assert_eq!(
        served
            .capture(&posed.effects)
            .expect("the capture must succeed"),
        vec![address()],
        "a step touching an address the capture did not name is a step whose rollback would give \
         nothing back"
    );
}

#[test]
fn a4_a_seized_document_is_given_back_whole_and_a_seized_absence_is_not() {
    // The pair, and it is the pair that has teeth: a restoration answering the
    // same thing to both would pass either of them alone. The distinction is
    // the whole of the requirement — a capture recording presence only would
    // restore an absence, so an update interrupted on an entry already present
    // would give back nothing, leaving the disk on the new version and the
    // registry on the old one.
    let served = behaviour(BehaviourName::Merge);
    let document = Captured::of(vec![Seized::Document {
        address: address(),
        contents: DOCUMENT.to_string(),
    }]);
    let absence = Captured::of(vec![Seized::Absent { address: address() }]);

    assert_eq!(
        served
            .restore(&document)
            .expect("the restoration must succeed"),
        Restoration {
            effects: vec![Effect::Restore {
                seized: Seized::Document {
                    address: address(),
                    contents: DOCUMENT.to_string(),
                },
            }],
        },
        "restoring an update must put the document from before back, byte for byte"
    );
    assert_ne!(served.restore(&document), served.restore(&absence));
}

#[test]
fn a4_a_restoration_gives_the_addresses_back_in_the_reverse_order_they_were_changed() {
    // A link pose materialises the store entry and then designates it. Giving
    // them back the other way round would take the materialisation away while
    // the link still designated it, and a rollback that then failed would leave
    // a link on the machine pointing at nothing.
    let served = behaviour(BehaviourName::Link);
    let store = PathBuf::from("/store/acme-skill");
    let captured = Captured::of(vec![
        Seized::Absent {
            address: store.clone(),
        },
        Seized::Absent { address: address() },
    ]);

    let restoration = served
        .restore(&captured)
        .expect("the restoration must succeed");

    assert_eq!(
        restoration.effects.first().map(|effect| effect.address()),
        Some(address().as_path()),
        "the address must be given back before the store entry it designates"
    );
    assert_eq!(
        restoration.effects.last().map(|effect| effect.address()),
        Some(store.as_path())
    );
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
    let written = match posed.effects.as_slice() {
        [Effect::Write { contents, .. }] => contents.clone(),
        other => panic!("a merge writes one document and only one: {other:?}"),
    };
    assert!(written.contains("statusLine"));

    let undone = served
        .undo(
            Subject {
                address: &address(),
                observed: Some(&written),
            },
            &posed.trace,
            Referents::Last,
        )
        .expect("the trace must run backwards");

    assert_eq!(
        match undone.effects.as_slice() {
            [Effect::Write { contents, .. }] => contents.clone(),
            other => panic!("a removal writes one document and only one: {other:?}"),
        },
        DOCUMENT,
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

/// Guard, not scenario: **A4 · 4 requires that a behaviour added to the closed
/// set without declaring its capture and its restoration make the build fail**,
/// and this checks that the three examples which realise it are still there.
///
/// The clause is realised by the compiler and not by an assertion, so it is
/// realised by doctests on the contract of a behaviour — a positive twin that
/// compiles, and two refusals, one omitting `capture` and one omitting
/// `restore`. **A doctest has no name.** Nothing in this repository could then be
/// grepped for the identifier, and the clause would go missing the day somebody
/// rewrote the prose that mentions it, with the whole suite green. This test is
/// where that identifier lives.
///
/// **The three, and not the two refusals.** A `compile_fail` goes green on any
/// compilation error at all, a typo included; it has teeth only beside the twin
/// that compiles. A guard anchoring the refusals alone would let the twin be
/// deleted without going red, and A4 · 4 would stay ticked while measuring
/// nothing.
///
/// **What it cannot see.** That each block still defines a behaviour omitting
/// the method it is named for; that a `compile_fail` fails for that omission
/// rather than for a typo somebody left in it; that the twin still exercises the
/// same shape as the two refusals. Those are properties of what is inside the
/// fences, and only reading the examples tells them. What is anchored here is
/// that the fences are on the **contract's own doc block**, in the expected
/// kinds and order — a count over the whole file would go green on fences moved
/// onto any other item in it.
#[test]
fn guard_a4_the_behaviour_contract_still_carries_the_three_examples_that_realise_it() {
    let source = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
        .expect("read the crate's own source");

    assert_eq!(
        fenced_examples(&preamble(&source, "\npub trait Behaviour {")),
        vec![
            "".to_string(),
            "compile_fail".to_string(),
            "compile_fail".to_string()
        ],
        "the contract of a behaviour no longer carries the twin that compiles and the two \
         refusals that do not — the clause requiring a behaviour without its capture and its \
         restoration to fail the build is realised by those three and by nothing else"
    );
}

/// Every value this crate hands back carries `#[must_use]`, and each is refused
/// by a pair of examples on the method that hands it back rather than by an
/// assertion here.
///
/// **What this adds is the only thing those pairs cannot hold: their own
/// existence.** Delete an attribute and its `compile_fail` starts compiling, so
/// the doctest goes red by itself. Delete the doc block instead and nothing
/// anywhere goes red — the attribute keeps working and stops being measured,
/// which is the state this whole file exists to refuse.
///
/// It lives here rather than in a file of its own because the helper it needs
/// was already written for the guard above, and because both anchor examples on
/// the same trait. Nothing about this crate being pure changes the shape: what a
/// dropped value costs here is a computed thing never carried, not a disk left
/// half written.
#[test]
fn guard_every_must_use_of_the_behaviour_contract_still_carries_the_pair_that_measures_it() {
    let source = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
        .expect("read the crate's own source");

    for (method, anchor) in [
        ("Behaviour::pose", "\n    fn pose("),
        ("Behaviour::undo", "\n    fn undo("),
        ("Behaviour::restore", "\n    fn restore("),
    ] {
        assert_eq!(
            fenced_examples(&preamble(&source, anchor)),
            vec!["compile_fail".to_string(), "no_run".to_string()],
            "the doc block of `{method}` no longer carries the refusal that drops the value and \
             the twin that keeps it — the attribute on the value it hands back is then held by \
             nothing, and dropping that value goes back to compiling in silence"
        );
    }
}

/// The lines immediately above a declaration: its doc block and its attributes,
/// in source order.
///
/// Anchored on the declaration and not on the file, so that fences moved onto
/// another item stop counting — which is the way a count over a whole file goes
/// green while the thing it was watching is gone.
///
/// **It takes the first occurrence**, which for the trait's own methods is the
/// declaration rather than any implementation of it: the trait precedes the
/// members of the set in this source. Should that ever stop being true, the
/// preamble found would be an implementation's — which carries no fenced
/// examples — and every caller below goes red rather than quietly green.
fn preamble(source: &str, declaration: &str) -> String {
    let at = source
        .find(declaration)
        .unwrap_or_else(|| panic!("`{}` must still be declared here", declaration.trim()));
    let mut block: Vec<&str> = source[..at]
        .lines()
        .rev()
        .take_while(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("///") || trimmed.starts_with("#[")
        })
        .collect();
    block.reverse();
    block.join("\n")
}

/// The info string of every fenced example in a doc block, in order — empty for
/// a block that is run, `compile_fail` for one that must not build.
///
/// Opening and closing fences are told apart by alternation, which is what the
/// format itself does: a closing fence carries no info string and would
/// otherwise be counted as one more example that runs.
fn fenced_examples(doc: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut inside = false;
    for line in doc.lines() {
        let Some(content) = line.trim_start().strip_prefix("///") else {
            continue;
        };
        let Some(info) = content.trim().strip_prefix("```") else {
            continue;
        };
        if inside {
            inside = false;
        } else {
            inside = true;
            found.push(info.trim().to_string());
        }
    }
    found
}
