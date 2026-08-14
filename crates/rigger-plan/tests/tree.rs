//! The pose of a whole directory, as values.
//!
//! A test prefixed with an identifier realises that requirement. A4 — an
//! interrupted transaction gives back the state that preceded it, and the half
//! of it this crate carries is the shape of the steps: the store tree is planted
//! before it is designated, and uprooted in a step of the same list as the rest.
//! A5 — the set never shrinks in silence, and a trace this build did not write
//! is refused by naming it rather than guessed.
//!
//! Those prefixed with `guard_` realise no requirement. They state what the
//! shape above relies on: an order-free fingerprint, and a manifest two
//! different trees cannot both produce.
//!
//! **This crate is pure, so nothing here touches a disk.** What is measured is
//! the decision — which steps, in which order, under which conditions.

use std::path::{Path, PathBuf};

use rigger_plan::{
    behaviour, record, replay, Behaviour, BehaviourError, BehaviourName, Digest, Effect, Fragment,
    Placement, Referents, Subject, Trace, Tree, TreeEntry,
};

fn address() -> PathBuf {
    PathBuf::from("/root/skills/graphify")
}

fn store() -> PathBuf {
    PathBuf::from("/store/acme-graphify-1.0")
}

fn entry(name: &str, contents: &str) -> TreeEntry {
    TreeEntry {
        name: name.to_string(),
        contents: contents.to_string(),
    }
}

/// A tree with the shape the reference catalogue's largest skill has: files at
/// the root and files one directory down. A flat tree would leave the nesting
/// unmeasured, and nesting is where a name and its separator start to matter.
fn skill() -> Tree {
    Tree::of(vec![
        entry("SKILL.md", "# Graphify\n"),
        entry("references/queries.md", "## Queries\n"),
        entry("scripts/build.sh", "#!/bin/sh\nexit 0\n"),
    ])
}

fn tree(placement: Placement) -> Fragment {
    Fragment::Tree {
        store: store(),
        entries: skill(),
        placement,
    }
}

fn link() -> &'static dyn Behaviour {
    behaviour(BehaviourName::Link)
}

fn subject(address: &Path) -> Subject<'_> {
    Subject {
        address,
        observed: None,
    }
}

#[test]
fn guard_a_tree_fingerprints_the_same_whatever_order_its_files_arrive_in() {
    // A directory listing promises no order, so the same tree read on two
    // filesystems arrives in two orders. If the fingerprint followed the order
    // of arrival, the diagnostic would report a tree nobody touched as rewritten
    // by somebody else — on every machine but the one that posed it.
    let one_way = Tree::of(vec![
        entry("SKILL.md", "# Graphify\n"),
        entry("references/queries.md", "## Queries\n"),
    ]);
    let the_other = Tree::of(vec![
        entry("references/queries.md", "## Queries\n"),
        entry("SKILL.md", "# Graphify\n"),
    ]);

    assert_eq!(one_way.fingerprint(), the_other.fingerprint());
    assert_eq!(
        one_way, the_other,
        "two readings of one directory must be one value, not two that agree on a digest"
    );
}

#[test]
fn guard_two_trees_that_differ_only_by_where_a_name_ends_do_not_fingerprint_alike() {
    // The pair the length in front of every name exists for: concatenated
    // without it, `a` holding `bc` and `ab` holding `c` produce the same bytes,
    // and one tree passes for the other — so a removal conditioned on the
    // fingerprint would uproot a directory it never planted.
    let one = Tree::of(vec![entry("a", "bc")]);
    let other = Tree::of(vec![entry("ab", "c")]);

    assert_ne!(one.fingerprint(), other.fingerprint());
}

#[test]
fn guard_a_tree_pose_plants_the_store_tree_once_and_then_designates_it() {
    let posed = link()
        .pose(subject(&address()), &tree(Placement::Link))
        .expect("the pose must succeed");

    assert_eq!(
        posed.effects,
        vec![
            Effect::Plant {
                address: store(),
                entries: skill(),
            },
            Effect::Link {
                address: address(),
                to: store(),
            },
        ],
        "the store tree must be planted before anything designates it, and each of the two must be \
         one step: N steps are what a rollback would have to unwind exactly right"
    );
    assert_eq!(posed.fingerprint, skill().fingerprint());
    assert_eq!(
        posed.trace,
        Trace::Tree {
            store: store(),
            placement: Placement::Link,
            posed: skill().fingerprint(),
        },
        "one identity, one address, one fingerprint — whatever the number of files"
    );
}

#[test]
fn guard_a_tree_posed_by_copy_plants_the_address_instead_of_designating_it() {
    let posed = link()
        .pose(subject(&address()), &tree(Placement::Copy))
        .expect("the pose must succeed");

    assert_eq!(
        posed.effects.last(),
        Some(&Effect::Plant {
            address: address(),
            entries: skill(),
        }),
        "a copy places the whole tree at the address, and still as one step"
    );
}

#[test]
fn a4_the_planted_store_tree_is_uprooted_at_the_last_referent_and_never_before() {
    let trace = Trace::Tree {
        store: store(),
        placement: Placement::Copy,
        posed: skill().fingerprint(),
    };

    let last = link()
        .undo(subject(&address()), &trace, Referents::Last)
        .expect("the trace must run backwards");
    let remaining = link()
        .undo(subject(&address()), &trace, Referents::Remaining)
        .expect("the trace must run backwards");

    assert_eq!(
        last.effects,
        vec![
            Effect::Uproot {
                address: address(),
                posed: skill().fingerprint(),
            },
            Effect::Uproot {
                address: store(),
                posed: skill().fingerprint(),
            },
        ],
        "both the address and the store tree go, each conditioned on the fingerprint that was \
         planted — the product takes back the tree it posed and nothing else"
    );
    assert_eq!(
        remaining.effects,
        vec![Effect::Uproot {
            address: address(),
            posed: skill().fingerprint(),
        }],
        "something else still designates the store tree, so it stays"
    );
}

#[test]
fn a5_a_recorded_tree_trace_reads_back_as_a_tree_and_never_as_a_single_artefact() {
    let posed = Trace::Tree {
        store: store(),
        placement: Placement::Copy,
        posed: skill().fingerprint(),
    };
    let artefact = Trace::Link {
        store: store(),
        placement: Placement::Copy,
        posed: skill().fingerprint(),
    };

    let recorded = record(&posed).expect("a tree trace must be recordable");
    let of_the_artefact = record(&artefact).expect("a link trace must be recordable");

    // The two carry the same three things, so nothing but the shape written in
    // front of them tells them apart once they are strings. Read one as the
    // other and the removal sends a file-shaped step at a directory: a posted
    // tree nothing takes back off.
    assert_ne!(recorded, of_the_artefact);
    assert_eq!(replay(BehaviourName::Link, &recorded), Ok(posed));
    assert_eq!(replay(BehaviourName::Link, &of_the_artefact), Ok(artefact));
}

#[test]
fn a5_a_trace_shape_this_build_did_not_write_is_refused_rather_than_guessed() {
    let invented = [
        "bush".to_string(),
        "/store/acme".to_string(),
        "copy".to_string(),
        Digest::of(b"whatever").to_string(),
    ];

    let refusal =
        replay(BehaviourName::Link, &invented).expect_err("this build wrote no such line");

    match refusal {
        BehaviourError::TraceUnreadable { behaviour, reason } => {
            assert_eq!(behaviour, BehaviourName::Link);
            assert!(
                reason.contains("4 field(s)"),
                "the refusal must say what it could not read: {reason}"
            );
        }
        other => panic!("expected an unreadable trace, got {other}"),
    }
}
