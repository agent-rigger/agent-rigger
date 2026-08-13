//! B5 (MD-02) and B6 (MD-10·2) — the withdrawal, its referents, and what a
//! trace with none of them means for a value the product only witnessed.
//!
//! # What "adoption" names, and what it does not name here
//!
//! Nothing in this workspace defines an `adopt` function, an `Adopt`
//! behaviour, or an `Adopt` trace. "Adoption" is the word MD-02 and MD-10 use
//! for one transition: an artefact already sitting on a machine, at an
//! address this product manages, brought under the registry's management
//! without the product having written a byte of it. The closed set of
//! behaviours already names the candidate for that transition —
//! [`rigger_plan::BehaviourName::Probe`], documented as "observe a presence,
//! and write nothing" (`rigger-plan/src/lib.rs:160`) — but `Probe`'s four
//! methods all refuse with `BehaviourError::NotBuilt`
//! (`rigger-plan/src/lib.rs:1560`): the behaviour is named, and nothing
//! serves it yet. There is no distinct "adoption" code path to exercise. The
//! one entrypoint any posting — adopted or freshly written — goes through is
//! [`Entry::posted`], and that is what both tests below would drive directly,
//! the same way every other test in this crate's suite does.
//!
//! # B5 — what this test establishes
//!
//! MD-02 asks that an adoption whose trace designates no referent be refused
//! at registration, naming the address and the behaviour — never recorded and
//! then counted as zero. [`Trace::store`] is what "designates a referent"
//! means in this crate: `Some` for `Trace::Link`, `None` for `Trace::Grammar`
//! and for `Trace::Witnessed`.
//!
//! `Trace::Link` cannot express "no referent" any more — its `store` field is
//! a plain `PathBuf`, not an `Option`, so the narrowest form of MD-02 is
//! already closed by the type, exactly as MD-02's own "élément du modèle à
//! ajouter" asked for. Of the two shapes that do designate no referent, one
//! is legitimately accepted that way: `Trace::Witnessed` is exactly a value
//! this build only observed, and B6 below measures that it is kept, not
//! refused. The other, `Trace::Grammar`, is refused by `record`
//! (`rigger-plan/src/lib.rs:708`) unconditionally, so it plays no part here.
//!
//! What MD-02 actually describes — an adoption meant to be link-shaped,
//! ending up with no referent — has no way to happen through a well-typed
//! `link` pose, because `Trace::Link` cannot omit its `store`. It used to
//! still happen at the boundary `Entry::posted` exposes: nothing there
//! checked that a `Posting`'s free-form `behaviour: String` label agreed with
//! the shape of its `trace: Trace`. A `Posting` carrying `behaviour: "link"`
//! and `trace: Trace::Witnessed` compiled, and `Entry::posted`
//! (`rigger-registry/src/ledger.rs:499`) accepted it: `record` dispatched on
//! the `Trace` variant alone, never read `posting.behaviour`, and the
//! registry ended up holding an entry labelled `link` whose recorded trace
//! was the empty list `Trace::Witnessed` writes — the shape of the historical
//! MD-02 defect, an adopted entry recorded as `files: []`. The test below
//! measured that, red, before `Entry::posted` gained the check.
//!
//! The codebase already had the shape of the check MD-02 wants:
//! `BehaviourError::WrongShape` refuses a trace that does not match the
//! behaviour asked of it — for instance `Link::undo` refusing anything but a
//! `Trace::Link` (`rigger-plan/src/lib.rs:1359`-`1372`) — but only inside a
//! `Behaviour`'s own `pose` and `undo`, asked when a removal is decided. It
//! is reused rather than rebuilt: `Entry::posted` now calls a free function,
//! `behaviour_matches_trace` (`rigger-registry/src/ledger.rs`), that resolves
//! `posting.behaviour` through the closed set and, only when it resolves,
//! checks the trace's shape against it — `link` against `Trace::Link`,
//! `merge` against `Trace::Grammar`, `probe` against `Trace::Witnessed`,
//! `delegate` against nothing, since no member of `Trace` is its own yet. A
//! `behaviour` outside the closed set is left alone at this boundary: the set
//! may shrink between two versions of the product, and that case is
//! `resolve_behaviour`'s to refuse, by naming the behaviour, at removal —
//! never here, and not this defect's shape in any case.
//!
//! # B6 — what this test establishes, corrected (B10, F4)
//!
//! A value the product only witnessed — `Trace::Witnessed`, closed by B1
//! (MD-08·2 + MD-10·1) so that it can never carry an inverse — is posted
//! under its own identity, alongside an ordinary `link`-posed entry. A later
//! removal takes only the identity it names, and the witnessed entry, which
//! is not that identity, survives, unchanged.
//!
//! **What actually makes it survive.** [`Ledger::remove`] is `retain` on
//! `Identity` alone (`rigger-registry/src/ledger.rs`) — it never reads a kept
//! or a removed entry's `Trace`. The witnessed entry survives for the same
//! reason any *other* identity would: it is not the one asked for. This doc
//! used to claim the survival flowed from `Trace::store` returning `None` for
//! `Trace::Witnessed` — i.e. from store-referent accounting `remove` was said
//! to also perform. `remove` performs no such accounting, for any entry: the
//! claim was false, found by a mutation that swapped `witnessed()` for an
//! ordinary `link`-posed entry in the test below and left it green either way
//! (closing adversarial review of famille-b, F4, 2026-08-13).
//!
//! `Ledger::referents` (`rigger-registry/src/ledger.rs`) is where
//! store-referent accounting actually lives in this crate, and it *is* where
//! `Trace::store` returning `None` for `Trace::Witnessed` would matter — but
//! no removal in this crate calls it while taking an identity out;
//! `referents` is a separate query a caller consults beforehand, at the
//! boundary with `rigger-apply`, and neither this test nor `Ledger::remove`
//! exercises it. So the stronger reading MD-10·2 invites — that a witnessed
//! value is spared *by* referent accounting — is not measurable through this
//! crate's `remove` today. What is measurable, and what the test below
//! actually establishes, is the weaker fact: identity-scoped removal leaves
//! every other identity alone, witnessed or not. That fact is not particular
//! to `Trace::Witnessed` either — `envelope.rs` and `shared_address.rs`
//! already establish it for ordinary `link` entries — so this test's
//! remaining, genuine contribution is narrower still: it is the one place
//! that posts a `Trace::Witnessed` value at all and confirms that removal
//! treats it no differently, for better or worse.
//!
//! What this does not establish: that *no* removal can ever reach a witnessed
//! entry in general. `Trace::Witnessed` carries no inverse, so nothing in
//! this crate or `rigger-apply` can compute a plan to undo it in the first
//! place — that is a stronger, compile-time guarantee, and it is B1's
//! (`Trace::Witnessed` cannot destructure an inverse that is not there), not
//! a runtime property this file re-measures.

use std::path::{Path, PathBuf};

use rigger_plan::{BehaviourError, BehaviourName, Digest, Placement, Trace};
use rigger_registry::{Address, Entry, Ledger, Posting, POSED_BY};

/// A fingerprint this build writes: sixteen lowercase hexadecimal digits,
/// which is the only shape `Digest::read` accepts back.
const FINGERPRINT: &str = "0123456789abcdef";

/// An entry this build only observed: an address it manages, the fingerprint
/// of what is there, and a trace that writes nothing back — see the module
/// docs for why `Trace::Witnessed` is the closed shape B1 gave this state.
fn witnessed(id: &str, address: &str) -> Entry {
    Entry::posted(Posting {
        id: id.to_string(),
        provenance: "acme".to_string(),
        behaviour: "probe".to_string(),
        posed_by: POSED_BY.to_string(),
        root: Address::new(Path::new("/home/someone/.claude")).expect("a UTF-8 root"),
        address: Address::new(Path::new(address)).expect("a UTF-8 address"),
        fingerprint: FINGERPRINT.to_string(),
        trace: Trace::Witnessed,
    })
    .expect("a witnessed trace always records — it writes the empty list")
}

/// An entry this build actually posed, by link — the ordinary case a removal
/// is meant to act on.
fn posed(id: &str, address: &str, store: &Path) -> Entry {
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
fn b6_an_adoption_whose_trace_designates_no_referent_is_refused() {
    // GIVEN a posting labelled `link` — an adoption meant to be link-shaped,
    // claiming a referent in the shared store — but carrying the trace a
    // value only observed writes: `Trace::Witnessed`, which `Trace::store`
    // already reads as designating none.
    let contradicted = Posting {
        id: "acme/hand-written-plugin".to_string(),
        provenance: "acme".to_string(),
        behaviour: "link".to_string(),
        posed_by: POSED_BY.to_string(),
        root: Address::new(Path::new("/home/someone/.claude")).expect("a UTF-8 root"),
        address: Address::new(Path::new("hand-written-plugin.js")).expect("a UTF-8 address"),
        fingerprint: FINGERPRINT.to_string(),
        trace: Trace::Witnessed,
    };

    // WHEN it is registered.
    let refusal = Entry::posted(contradicted).expect_err(
        "a `link` label over a witnessed trace must not record — MD-02·3 refuses a posting \
         whose declared behaviour and recorded trace contradict each other",
    );

    // THEN the refusal names `link`, the behaviour the label claimed — never
    // an entry recorded under that label with the empty trace `Witnessed`
    // writes, the shape of the historical MD-02 defect: an adopted entry
    // recorded as `files: []`.
    assert!(
        matches!(
            &refusal,
            BehaviourError::WrongShape { behaviour, .. } if *behaviour == BehaviourName::Link
        ),
        "the refusal must name `link`, the behaviour the posting claimed: {refusal}"
    );
    assert!(
        refusal.to_string().contains("link"),
        "what was refused must be nameable by whoever reads the message: {refusal}"
    );
}

#[test]
fn b12_a_value_the_product_only_observed_survives_a_later_removal() {
    // GIVEN a value this build only observed — found already on the machine,
    // never written by the product — beside one it actually posed.
    let observed = witnessed("acme/hand-written-plugin", "hand-written-plugin.js");
    let materialised = posed(
        "acme/review",
        "review.md",
        Path::new("/home/someone/.rigger/store/acme-review-1.0"),
    );

    let mut ledger = Ledger::empty();
    ledger.upsert(observed.clone());
    ledger.upsert(materialised.clone());

    // WHEN a later removal takes away what the product posed — an identity
    // the observed value never shared. `Ledger::remove` is `retain` on
    // `Identity` alone: it does not read `materialised`'s trace, or
    // `observed`'s, to decide anything (B10, F4 — see the module doc).
    ledger.remove(materialised.identity());

    // THEN the observed value survives, because it is not the identity that
    // was asked for — the only thing `remove` checks. This does not
    // establish that store-referent accounting spares it: `remove` performs
    // none, for any entry.
    assert_eq!(
        ledger.entries().len(),
        1,
        "a removal of a different identity must not also take the witnessed entry"
    );
    assert_eq!(
        ledger.entries()[0],
        observed,
        "the survivor must be the witnessed entry, unchanged"
    );
}

/// F6 (B10) — the two arms of `behaviour_matches_trace` beside `Link` that
/// carry real, unguarded behaviour: `Probe` and `Delegate`. `Merge` is not
/// covered here — `record` already refuses `Trace::Grammar` unconditionally
/// (`rigger-plan/src/lib.rs:708`), so that arm is honestly unreachable, not
/// merely untested.
///
/// A `probe` label claims "observe a presence, and write nothing"
/// (`rigger-plan/src/lib.rs:160`) — its own trace shape is `Trace::Witnessed`,
/// which designates no store referent (`Trace::store` reads `None` for it).
/// `Trace::Link` designates one. Were this pairing accepted, the entry would
/// count as a referent of the shared store while carrying the `probe` label,
/// and `Probe::undo` refuses unconditionally with `BehaviourError::NotBuilt`
/// (`rigger-plan/src/lib.rs:1577`) — so nothing could ever remove it: the
/// store entry becomes indestructible under a label documented as writing
/// nothing.
#[test]
fn f6_a_probe_posting_over_a_trace_that_designates_a_referent_is_refused() {
    let contradicted = Posting {
        id: "acme/hand-written-plugin".to_string(),
        provenance: "acme".to_string(),
        behaviour: "probe".to_string(),
        posed_by: POSED_BY.to_string(),
        root: Address::new(Path::new("/home/someone/.claude")).expect("a UTF-8 root"),
        address: Address::new(Path::new("hand-written-plugin.js")).expect("a UTF-8 address"),
        fingerprint: FINGERPRINT.to_string(),
        trace: Trace::Link {
            store: PathBuf::from("/home/someone/.rigger/store/acme-review-1.0"),
            placement: Placement::Link,
            posed: Digest::read(FINGERPRINT).expect("a fingerprint this build wrote"),
        },
    };

    let refusal = Entry::posted(contradicted).expect_err(
        "a `probe` label over a trace that designates a store referent must not record — \
         `Probe::undo` always refuses, so an accepted entry would be permanently un-removable",
    );

    assert!(
        matches!(
            &refusal,
            BehaviourError::WrongShape { behaviour, .. } if *behaviour == BehaviourName::Probe
        ),
        "the refusal must name `probe`, the behaviour the posting claimed: {refusal}"
    );
}

/// `Delegate` has no trace shape of its own — `record` only knows `Link`,
/// `Grammar`, and `Witnessed` (`rigger-plan/src/lib.rs:708`) — so
/// `behaviour_matches_trace` must refuse it unconditionally, whatever trace
/// accompanies it. This uses `Trace::Witnessed`, the trace that would
/// otherwise record cleanly, precisely to show the refusal is about the label
/// `delegate` having nothing to agree with, not about a mismatched trace
/// shape.
#[test]
fn f6_a_delegate_posting_is_refused_regardless_of_the_trace_it_carries() {
    let contradicted = Posting {
        id: "acme/host-mechanism".to_string(),
        provenance: "acme".to_string(),
        behaviour: "delegate".to_string(),
        posed_by: POSED_BY.to_string(),
        root: Address::new(Path::new("/home/someone/.claude")).expect("a UTF-8 root"),
        address: Address::new(Path::new("host-mechanism.js")).expect("a UTF-8 address"),
        fingerprint: FINGERPRINT.to_string(),
        trace: Trace::Witnessed,
    };

    let refusal = Entry::posted(contradicted).expect_err(
        "a `delegate` label must not record — no member of `Trace` serves it yet, so \
         `behaviour_matches_trace` must refuse regardless of which trace accompanies it",
    );

    assert!(
        matches!(
            &refusal,
            BehaviourError::WrongShape { behaviour, .. } if *behaviour == BehaviourName::Delegate
        ),
        "the refusal must name `delegate`, the behaviour the posting claimed: {refusal}"
    );
}
