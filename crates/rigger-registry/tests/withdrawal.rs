//! MD-38·2 + MD-38·3b — the closed set of issues a withdrawal can conclude
//! with, `WithdrawalIssue`, and the exit code it derives.
//!
//! Two of its three members have a producer in this product today, and both
//! are measured below: a withdrawal that goes all the way, and one the
//! caller declined. The third, `WithdrawalIssue::Partial`, is declared and
//! never exercised here — its own doc comment in `src/withdrawal.rs` says
//! why there is nothing to call it against: `pose::carry` is atomic by
//! construction, and no layer in this workspace orchestrates several
//! withdrawals against each other. No test in this file fabricates a state
//! to stand in for a partial withdrawal — that would carry the right name
//! and measure nothing, which is worse than an admitted gap.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::SystemLiveness;
use rigger_plan::{Digest, Placement, Trace};
use rigger_registry::{
    transact, Address, Consent, Decision, Entry, Identity, Mutation, Outcome, Posting, Proposal,
    Registry, WithdrawalIssue,
};

/// An empty working directory, private to this test — one per scenario, so
/// two tests running in parallel never share a registry or its lock.
fn directory(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("rigger-withdrawal-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create the working directory");
    path
}

/// A registry recording one entry, `E0`, posed by `link`.
fn registry_with_one_entry(dir: &Path) -> Registry {
    let entry = Entry::posted(Posting {
        id: "E0".to_string(),
        provenance: "acme".to_string(),
        behaviour: "link".to_string(),
        posed_by: "1.5".to_string(),
        root: Address::new(Path::new("/home/someone")).expect("a UTF-8 address"),
        address: Address::new(Path::new("E0.json")).expect("a UTF-8 address"),
        fingerprint: "0123456789abcdef".to_string(),
        trace: Trace::Link {
            store: PathBuf::from("/store/E0"),
            placement: Placement::Link,
            posed: Digest::read("0123456789abcdef").expect("a fingerprint this build wrote"),
        },
    })
    .expect("a link trace records");

    fs::create_dir_all(dir).expect("create the directory of the registry");
    let registry = Registry::at(dir.join("registry"));
    let outcome = transact(
        &registry,
        &[Mutation::Upsert(entry)],
        &Granting,
        &SystemLiveness,
    )
    .expect("the fixture write must succeed");
    assert!(matches!(outcome, Outcome::Committed { .. }));
    registry
}

/// Proposes taking `E0` back off.
fn withdrawing_e0() -> Mutation {
    Mutation::Remove {
        identity: Identity {
            provenance: "acme".to_string(),
            id: "E0".to_string(),
        },
    }
}

/// Consent that grants.
struct Granting;

impl Consent for Granting {
    fn decide(&self, _: &Proposal<'_>) -> Decision {
        Decision::Granted
    }
}

/// Consent that refuses.
struct Refusing;

impl Consent for Refusing {
    fn decide(&self, _: &Proposal<'_>) -> Decision {
        Decision::Refused
    }
}

#[test]
fn md38_a_complete_withdrawal_exit_codes_as_complete_and_takes_the_entry_out() {
    // GIVEN a registry recording `E0`, and a caller who grants its removal.
    let dir = directory("complete");
    let registry = registry_with_one_entry(&dir);

    // WHEN the withdrawal is proposed and the caller consents.
    let outcome = transact(&registry, &[withdrawing_e0()], &Granting, &SystemLiveness)
        .expect("the transaction must succeed");
    assert!(matches!(outcome, Outcome::Committed { .. }));
    assert!(
        registry
            .read()
            .expect("read the registry back")
            .entries()
            .is_empty(),
        "a complete withdrawal must take the entry out of the registry"
    );

    // THEN the issue this product's own closed set names for it is derived
    // from the transaction's outcome, not chosen again here — `Complete` —
    // and its exit code is 0.
    let issue = WithdrawalIssue::of_withdrawal(&outcome);
    assert_eq!(issue, WithdrawalIssue::Complete);
    assert_eq!(issue.exit_code(), 0);

    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn md38_a_refused_consent_is_not_a_failure_and_exit_codes_like_a_complete_withdrawal() {
    // GIVEN a registry recording `E0`, and a caller who declines its
    // removal.
    let dir = directory("refused");
    let registry = registry_with_one_entry(&dir);
    let before = fs::read(registry.path()).expect("read the registry file");

    // WHEN the withdrawal is proposed and the caller refuses. MD-38 names
    // giving this event no exit code distinct from a real failure as part
    // of the gap, so `transact` must not report it as an error either.
    let outcome = transact(&registry, &[withdrawing_e0()], &Refusing, &SystemLiveness)
        .expect("a refusal to consent must not be reported as a failure");
    assert!(matches!(outcome, Outcome::Refused { .. }));
    assert_eq!(
        fs::read(registry.path()).expect("read back"),
        before,
        "a refused withdrawal must leave the registry untouched"
    );

    // THEN the issue is `ConsentRefused` — named among this closed set
    // rather than left for a caller to invent — and its exit code is the
    // *same* one a complete withdrawal gets. MD-38 requires that a refusal
    // never be counted among failures; it does not require that it be
    // distinguishable from success, and asserting equality here is what
    // measures the requirement actually written rather than a stronger one
    // nobody asked for.
    let issue = WithdrawalIssue::of_withdrawal(&outcome);
    assert_eq!(issue, WithdrawalIssue::ConsentRefused);
    assert_eq!(
        issue.exit_code(),
        WithdrawalIssue::Complete.exit_code(),
        "a refused consent must not exit as a failure — the product did exactly what it was \
         asked, so a script watching only the exit code must see it the same way it sees a \
         complete withdrawal"
    );

    fs::remove_dir_all(&dir).expect("clean up");
}
