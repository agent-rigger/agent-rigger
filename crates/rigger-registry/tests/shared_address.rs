//! Two `link` entries that resolve to the same shared store entry are both
//! counted, and neither is erased by removing the other.
//!
//! **This file used to call the store entry an "effective address", and that
//! was wrong — B11 corrected it.** The glossary (`CONTEXT.md`) defines
//! **effective address** as the granularity *under* the file, indexed by the
//! form of writing: two poses share an effective address when withdrawing
//! one finds what the other wrote — the key `unmerge` uses to find what
//! `merge` posed. ADR-0039 states it is "defined there and nowhere else". A
//! `link` pose's store entry is a different granularity entirely: a whole
//! materialisation, shared by address, never split under one file. This file
//! now calls it what it is — a **shared store entry** — and reserves
//! "effective address" for the glossary's own meaning.
//!
//! **What this file does not establish, and used to imply it did: MD-08·1.**
//! The registry's scenario for MD-08 is two `merge` entries, bounded block,
//! both resolving to the same `AGENTS.md` — the sub-file granularity the
//! glossary calls the effective address, not a shared store entry. That
//! scenario is not instrumentable on this build: [`rigger_plan::record`]
//! refuses every [`Trace::Grammar`] unconditionally, naming
//! [`rigger_plan::BehaviourError::NotRecordable`], before either entry is ever posted —
//! not a refusal that depends on there being two of them, or on which
//! address is targeted. The same refusal is exercised independently in
//! `rigger_plan`'s
//! `a4_a_pose_whose_trace_the_registry_cannot_hold_is_refused_before_it_happens`
//! (`crates/rigger-plan/tests/link.rs`) and in `rigger_apply`'s
//! `a4_a_pose_whose_trace_the_registry_could_not_hold_never_touches_the_machine`
//! (`crates/rigger-apply/tests/rollback.rs`). A `merge` entry cannot be
//! registered at all today, so two of them sharing an effective address
//! cannot be either — MD-08·1 stays open, and no test in this crate closes
//! it.
//!
//! **What this file does establish.** Two `link` entries, built from distinct
//! identities and posted to the same shared store entry, are both held by the
//! [`Ledger`] at once — neither is folded into the other on `upsert`.
//! Removing one leaves the other exactly as it was, field for field. And the
//! registry's own signal for "does something else still reach it" tracks
//! that: it answers `Remaining` while both are held, and `Last` once only one
//! is. **This is not new coverage ADR-0039 added** — the ADR's own
//! "Élément du modèle à ajouter" note names referent counting "aujourd'hui
//! propriété du seul comportement `link`", i.e. already true of `link` before
//! this file existed. This file is a characterization test of that
//! pre-existing property at the ledger, complementing
//! `a4_one_materialisation_serves_two_things_and_goes_with_the_last_of_them`
//! (`crates/rigger-registry/tests/tracer_bullet.rs`), which covers the same
//! property through the disk by way of install and uninstall; this one holds
//! it at the ledger, without going through `pose()` or `transact()`.
//!
//! **What this file also does not establish, for an unrelated reason.**
//! [`Referents`] carries exactly two variants, `Remaining` and `Last` — an
//! answer to "does anything else still designate it", never a count. Nothing
//! in this crate can report "two referents" today; this test drives that
//! fact from the outside, by constructing exactly two entries and reading the
//! ledger's own `entries().len()`, rather than asking the model to say the
//! number. That gap belongs to whichever tranche owns `Referents`, and is not
//! closed here.

use std::path::{Path, PathBuf};

use rigger_plan::{Digest, Placement, Referents, Trace};
use rigger_registry::{Address, Entry, Ledger, Posting, POSED_BY};

/// A fingerprint this build writes: sixteen lowercase hexadecimal digits,
/// which is the only shape [`Digest::read`] accepts back.
const FINGERPRINT: &str = "0123456789abcdef";

/// Builds an entry that lands, through a Link pose, at `store` — the shared
/// store entry — while being addressed on its own, distinct, under
/// `address`.
fn posed_at(id: &str, address: &str, store: &Path) -> Entry {
    Entry::posted(Posting {
        id: id.to_string(),
        provenance: "acme".to_string(),
        behaviour: "link".to_string(),
        posed_by: POSED_BY.to_string(),
        root: Address::new(Path::new("/home/someone/.claude")).expect("a UTF-8 root"),
        address: Address::new(Path::new(address)).expect("a UTF-8 address"),
        fingerprint: FINGERPRINT.to_string(),
        trace: Trace::Link {
            store: store.to_path_buf(),
            placement: Placement::Link,
            posed: Digest::read(FINGERPRINT).expect("a fingerprint this build wrote"),
        },
    })
    .expect("a link trace records")
}

#[test]
fn two_link_entries_sharing_one_store_are_counted_and_not_erased() {
    let store: PathBuf = PathBuf::from("/home/someone/.rigger/store/acme-review-1.0");

    // GIVEN two entries, addressed on their own and distinct by identity, that
    // both resolve to the same shared store entry.
    let first = posed_at("review", "review.md", &store);
    let second = posed_at("review-too", "review-too.md", &store);

    let mut ledger = Ledger::empty();
    ledger.upsert(first.clone());
    ledger.upsert(second.clone());

    // THEN both are counted. Sharing the store entry is not sharing an
    // identity, and the ledger keys on the latter — the day it keyed on the
    // former, the second `upsert` above would have overwritten the first, and
    // this assertion is what would have caught it.
    assert_eq!(
        ledger.entries().len(),
        2,
        "two entries reaching the same shared store entry must both be counted, never folded \
         into one"
    );

    // AND the registry can already say, for either one taken alone, that the
    // shared store entry is still reachable through the other — the signal
    // ADR-0039 sends up to the model, and one already true of `link` before
    // that ADR.
    assert_eq!(
        ledger.referents(&store, first.identity()),
        Referents::Remaining,
        "the second entry still designates the shared store entry once the first is set aside"
    );
    assert_eq!(
        ledger.referents(&store, second.identity()),
        Referents::Remaining,
        "the first entry still designates the shared store entry once the second is set aside"
    );

    // WHEN the first is removed.
    ledger.remove(first.identity());

    // THEN the second is not erased: it reads back exactly as it was, field
    // for field, and it is the only entry left.
    assert_eq!(
        ledger.entries().len(),
        1,
        "removing one entry at a shared store entry must not remove the other"
    );
    assert_eq!(
        ledger.entries()[0],
        second,
        "the other entry must read back exactly as it was, unchanged by the removal"
    );

    // AND now nothing else designates the shared store entry: the registry's
    // signal moves from `Remaining` to `Last` because the second entry is
    // alone, not because it was ever in doubt.
    assert_eq!(
        ledger.referents(&store, second.identity()),
        Referents::Last,
        "with the first gone, nothing else designates the shared store entry any more"
    );
}
