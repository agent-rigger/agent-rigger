//! B10 — MD-08·1: two entries at one shared effective address are counted,
//! never erased.
//!
//! **The effective address is the store entry a Link (or Copy) pose actually
//! resolves to**, once resolution has run — [`Trace::store`] names it, and
//! [`Ledger::referents`] is the question the registry answers about it: does
//! anything else it records still designate this point, once one entry is
//! set aside. Two entries can legitimately name the same one — the shared
//! store this crate exists to keep counted rather than duplicated on disk —
//! and this file locks the verdict ADR-0039 ratified: the model's referent
//! count sits at this level, and no clause anywhere rejects a second entry
//! for landing where a first one already does.
//!
//! **What this test establishes.** Two entries built from distinct
//! identities and posted to the same store are both held by the [`Ledger`]
//! at once — neither is folded into the other on `upsert`. Removing one
//! leaves the other exactly as it was, field for field. And the registry's
//! own signal for "does something else still reach it" tracks that: it
//! answers `Remaining` while both are held, and `Last` once only one is.
//!
//! **What this test does not establish.** [`Referents`] carries exactly two
//! variants, `Remaining` and `Last` — an answer to "does anything else still
//! designate it", never a count. Nothing in this crate can report "two
//! referents" today; this test drives that fact from the outside, by
//! constructing exactly two entries and reading the ledger's own
//! `entries().len()`, rather than asking the model to say the number. That
//! gap belongs to whichever tranche owns `Referents`, and is not closed
//! here.

use std::path::{Path, PathBuf};

use rigger_plan::{Digest, Placement, Referents, Trace};
use rigger_registry::{Address, Entry, Ledger, Posting, POSED_BY};

/// A fingerprint this build writes: sixteen lowercase hexadecimal digits,
/// which is the only shape [`Digest::read`] accepts back.
const FINGERPRINT: &str = "0123456789abcdef";

/// Builds an entry that lands, through a Link pose, at `store` — the shared
/// effective address — while being addressed on its own, distinct, under
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
fn b10_two_entries_at_one_effective_address_are_counted_and_not_erased() {
    let store: PathBuf = PathBuf::from("/home/someone/.rigger/store/acme-review-1.0");

    // GIVEN two entries, addressed on their own and distinct by identity, that
    // both resolve to the same shared store entry.
    let first = posed_at("review", "review.md", &store);
    let second = posed_at("review-too", "review-too.md", &store);

    let mut ledger = Ledger::empty();
    ledger.upsert(first.clone());
    ledger.upsert(second.clone());

    // THEN both are counted. Sharing the effective address is not sharing an
    // identity, and the ledger keys on the latter — the day it keyed on the
    // former, the second `upsert` above would have overwritten the first, and
    // this assertion is what would have caught it.
    assert_eq!(
        ledger.entries().len(),
        2,
        "two entries reaching the same effective address must both be counted, never folded \
         into one"
    );

    // AND the registry can already say, for either one taken alone, that the
    // shared address is still reachable through the other — the signal
    // ADR-0039 sends up to the model.
    assert_eq!(
        ledger.referents(&store, first.identity()),
        Referents::Remaining,
        "the second entry still designates the shared address once the first is set aside"
    );
    assert_eq!(
        ledger.referents(&store, second.identity()),
        Referents::Remaining,
        "the first entry still designates the shared address once the second is set aside"
    );

    // WHEN the first is removed.
    ledger.remove(first.identity());

    // THEN the second is not erased: it reads back exactly as it was, field
    // for field, and it is the only entry left.
    assert_eq!(
        ledger.entries().len(),
        1,
        "removing one entry at a shared effective address must not remove the other"
    );
    assert_eq!(
        ledger.entries()[0],
        second,
        "the other entry must read back exactly as it was, unchanged by the removal"
    );

    // AND now nothing else designates the shared address: the registry's
    // signal moves from `Remaining` to `Last` because the second entry is
    // alone, not because it was ever in doubt.
    assert_eq!(
        ledger.referents(&store, second.identity()),
        Referents::Last,
        "with the first gone, nothing else designates the shared address any more"
    );
}
