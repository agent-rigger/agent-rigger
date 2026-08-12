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
//! # B6 — what this test establishes
//!
//! A value the product only witnessed — `Trace::Witnessed`, closed by B1
//! (MD-08·2 + MD-10·1) so that it can never carry an inverse — is posted
//! under its own identity, alongside an ordinary `link`-posed entry. A later
//! removal takes only the identity it names. The witnessed entry is not that
//! identity, and `Trace::store` returns `None` for it, so it plays no part in
//! any store-referent accounting the removal might also do: there is no
//! path, direct or through shared-store bookkeeping, by which this removal
//! ever held a claim on it. It survives, unchanged.
//!
//! What this does not establish: that *no* removal can ever reach a witnessed
//! entry in general. `Trace::Witnessed` carries no inverse, so nothing in
//! this crate or `rigger-apply` can compute a plan to undo it in the first
//! place — that is a stronger, compile-time guarantee, and it is B1's
//! (`Trace::Witnessed` cannot destructure an inverse that is not there), not
//! a runtime property this file re-measures.

use std::path::Path;

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
    // the observed value never shared, and a store address (`Trace::store`)
    // it never designates either.
    ledger.remove(materialised.identity());

    // THEN the observed value survives. A removal that never possessed it —
    // not by identity, not by referent — does not take it.
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
