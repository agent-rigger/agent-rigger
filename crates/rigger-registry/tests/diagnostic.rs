//! What a diagnostic pass may report about a posed entry, and how it fails
//! when it cannot answer.
//!
//! Four tranches share this file, because each asks the same underlying
//! question from a different angle: does what the registry says about a
//! posed entry still hold on the machine, and what does a diagnostic pass do
//! when it cannot tell — for one entry, for the whole registry, or for
//! something the registry never named at all.
//!
//! **MD-35, this file's own test.** A comparison built only from what a
//! catalogue declares and what the registry already recorded can answer
//! `equal` without a single byte read off disk — the two are just two
//! records, and two records agreeing says nothing about the bytes both are
//! supposed to describe. [`rigger_apply::Measured::of`] is the one function
//! able to produce a fingerprint of what is actually there, because its
//! whole body is the read. A block deleted by hand cannot make it produce
//! one, so no comparison built on its result can ever answer `conformant`
//! for that block — proved below by deleting one and reading the registry's
//! own agreement with the catalogue right through the deletion.
//!
//! **MD-36**, not yet written here: a diagnostic pass over several entries
//! where one posed document cannot be read renders that one entry
//! unjudgeable and still answers for every other entry the pass covers —
//! never the whole pass failing for one unreadable document.
//!
//! **MD-62**, not yet written here: an artefact on disk the registry never
//! named, and a store entry no live record designates any more, are each
//! reported undeclared, with the root under which they were found; a repair
//! offers two named outcomes per such find — adopt or remove — and carries
//! out neither without confirmation.
//!
//! None of the three introduces a state type. MD-36·2 fixed the *cardinal*
//! a verdict vocabulary would eventually be drawn from, never where such a
//! vocabulary lives — so every test in this file establishes its property
//! the way a removal decides what it may take away: by comparing values a
//! caller can already produce, never by declaring a new one to hold the
//! answer.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::Measured;
use rigger_plan::{replay, Digest, Placement, Trace};
use rigger_registry::{resolve_behaviour, Address, Entry, Posting, POSED_BY};

/// An empty working directory, private to this test — the pattern every
/// integration test touching a real file uses across this crate, so that two
/// tests running in parallel never share a directory.
fn machine(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("rigger-diagnostic-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create the working directory");
    path
}

#[test]
fn md35_a_block_deleted_by_hand_is_absent_and_never_conformant() {
    // MD-35 states its scenario on a bounded block posed by `merge` — a
    // block delimited by markers inside a larger document. The fixture
    // below poses by `link` instead, because `link` is the only behaviour
    // that both `record` accepts and `replay` reads back today: a `merge`
    // trace is `Trace::Grammar`, which `record` refuses outright, and the
    // one trace with no such refusal, `Trace::Witnessed`, carries no digest
    // to compare in the first place. This substitution does not narrow what
    // is established: `conformant` needing a disk-measured third term,
    // never satisfiable by two records agreeing, holds for whichever
    // behaviour posed — the comparison below never inspects which one did.
    //
    // GIVEN a block this build actually posed by `link`, and a catalogue
    // that publishes the same version it was posed under — so the
    // fingerprint the catalogue declares, `e1`, and the fingerprint the
    // registry recorded are the same value, both computed from the same
    // bytes once written at `root`/`skills/review.md`.
    let root = machine("md35");
    let address = Path::new("skills/review.md");
    let at = root.join(address);
    fs::create_dir_all(at.parent().expect("the address has a parent directory"))
        .expect("create the directory the block is posed under");
    const CONTENT: &[u8] = b"# Review\n\nRead the diff before the description.\n";
    fs::write(&at, CONTENT).expect("write the block this entry describes");

    let e1 = Digest::of(CONTENT);
    let entry = Entry::posted(Posting {
        id: "acme/review".to_string(),
        provenance: "acme".to_string(),
        behaviour: "link".to_string(),
        posed_by: POSED_BY.to_string(),
        root: Address::new(&root).expect("a UTF-8 root"),
        address: Address::new(address).expect("a UTF-8 address"),
        fingerprint: e1.to_string(),
        trace: Trace::Link {
            store: root.join("store/acme-review-1.0"),
            placement: Placement::Copy,
            posed: e1,
        },
    })
    .expect("a link trace records");

    // The trap the scenario names: `e1`, what the catalogue declares, and
    // `recorded`, what the registry already holds — read back through
    // `replay`, the function that turns the registry's own recorded strings
    // into a `Trace` — agree. A comparison stopping at this pair never
    // touches `at`, and would already call the block conformant on this
    // agreement alone.
    let behaviour = resolve_behaviour(&entry).expect("`link` is a member of the closed set");
    let recorded = match replay(behaviour, entry.trace())
        .expect("a `link` trace this build wrote replays back")
    {
        Trace::Link { posed, .. } => posed,
        other => panic!("a `link` entry replays to `Trace::Link`, never {other:?}"),
    };
    assert_eq!(
        e1, recorded,
        "the catalogue's declared fingerprint and the registry's recorded one must agree for this \
         to be MD-35's trap rather than some other defect — a diagnostic stopping here would \
         already call the block conformant, having read neither `at` nor a byte of it"
    );

    // WHEN the user deletes the block by hand. `at` is gone; neither `e1`
    // nor `recorded` changed, because the deletion wrote to neither the
    // catalogue nor the registry.
    fs::remove_file(&at).expect("the block existed a moment ago, to remove by hand");

    // THEN the one `Digest` a verdict of `conformant` needs as its third
    // term cannot be produced. `Measured::of` is the sole constructor able
    // to produce one, and its entire body is the read this scenario asks
    // for — so it is the read itself that answers, not a type standing in
    // for its result.
    let measured = Measured::of(&at);
    assert!(
        measured.is_err(),
        "a block deleted by hand must be measured absent — `Measured::of` reading `at` and \
         succeeding here would mean either the deletion above did not happen, or `at` no longer \
         names the block this entry describes: {measured:?}"
    );

    // `conformant` is `declared == recorded == measured`. The third term
    // does not exist, so the equation is never true — not because a state
    // machine forbids it, but because there is no `Digest` to put on its
    // right-hand side. `e1` and `recorded` are checked once more, now that
    // the block is gone, to keep the trap visible at the exact point where
    // a comparison limited to these two terms would already have answered:
    // they still agree, and agreeing was never the question.
    assert_eq!(
        e1, recorded,
        "still equal after the deletion — the defect MD-35 names is not that the catalogue and the \
         registry fall out of agreement, it is that agreeing settles nothing about `at`"
    );
}
