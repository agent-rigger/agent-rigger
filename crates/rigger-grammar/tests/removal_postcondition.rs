//! The post-condition a **removal** runs on its own output.
//!
//! C3 — after a removal, a post-condition re-reads the document and aborts,
//! naming what it found, if a value the recorded trace does not name has
//! disappeared.
//!
//! It has two witnesses, and each one is blind where the other sees. The
//! comparison of **values** enumerates leaves, so it catches a key or an array
//! element that left the document and says nothing about a comment. The
//! comparison of **comments** catches exactly what is not a leaf. This file
//! exercises the first; the second is exercised on the real grammar, where an
//! owner's end-of-line annotation is destroyed by a removal that reports
//! success.
//!
//! **The failure is established on the output, never deduced from the input
//! checks.** Every check that runs before the write passes below: the document
//! parses, the trace is well formed, the key it names is there. What the input
//! checks say is what we thought we understood; what the post-condition says is
//! what we did.

use rigger_grammar::{
    merge, unmerge, Applied, Edit, Grammar, GrammarError, GrammarRole, Inverse, Jsonc, MergeError,
    Probe, Resolution, SemanticValue, Value,
};

/// A document carrying, besides the posed key, two values of its owner in an
/// array and a comment.
const DOCUMENT: &str = concat!(
    "{\n",
    "\t// the owner wrote this\n",
    "\t\"instructions\": [\"AGENTS.md\", \"docs/rules.md\"],\n",
    "\t\"statusLine\": \"rigger\"\n",
    "}\n",
);

/// What the registry recorded for the pose of `statusLine`: that key, and
/// nothing else.
fn trace() -> Inverse {
    Inverse::Keys {
        path: Vec::new(),
        added: vec!["statusLine".to_string()],
        replaced: Vec::new(),
    }
}

/// A grammar whose write path is that of JSONC and whose **inverse** takes one
/// value of the owner along with the passage it was asked to remove.
///
/// It stands for a removal that widens by one element — the shape of the defect
/// the requirement names, reproduced deterministically rather than waited for.
struct WideningRemoval;

impl Grammar for WideningRemoval {
    const NAME: &'static str = "widening";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
    const PROBE: Probe = Jsonc::PROBE;

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Jsonc::round_trip(source)
    }

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        Jsonc::find_string_in_list(source, path, value)
    }

    // Forwarded like every search above it: this grammar differs from JSONC in
    // its **inversion** and in nothing else, and the accounting for the trace
    // shape used here asks this question before the inversion runs. Leaving it
    // to the trait's default would refuse as unsupported and stop the scenario
    // short of the post-condition it exists to measure — which is what the
    // default is for, and why it refuses loudly rather than answering.
    fn find_key(source: &str, path: &[String], key: &str) -> Result<bool, GrammarError> {
        Jsonc::find_key(source, path, key)
    }

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        Jsonc::apply(source, edit)
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        Ok(Jsonc::invert(source, inverse)?.replace("\"docs/rules.md\"", ""))
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Jsonc::values(source)
    }

    fn comments(source: &str) -> Result<Vec<String>, GrammarError> {
        Jsonc::comments(source)
    }
}

#[test]
fn c3_a_removal_that_destroys_a_value_outside_the_trace_fails_on_the_output() {
    // GIVEN a removal whose write makes `docs/rules.md` disappear, which the
    // recorded trace does not name.
    let refusal = unmerge::<WideningRemoval>(DOCUMENT, &trace())
        .expect_err("a value of the owner left the document without anything going red");

    // THEN the refusal names the value and its path.
    match &refusal {
        MergeError::RemovalLostValues { grammar, lost } => {
            assert_eq!(*grammar, "widening");
            assert_eq!(lost.len(), 1, "{lost:?}");
            assert_eq!(lost[0].path(), "instructions");
            assert_eq!(lost[0].value(), &Value::text("docs/rules.md"));
        }
        other => panic!("the refusal does not come from the post-condition: {other:?}"),
    }
    let message = refusal.to_string();
    for expected in ["docs/rules.md", "instructions"] {
        assert!(
            message.contains(expected),
            "the refusal does not name {expected:?}: {message}"
        );
    }

    // AND nothing comes back to be written. A refusal that still handed back a
    // document would leave the abort to the good manners of every caller.
    assert!(unmerge::<WideningRemoval>(DOCUMENT, &trace()).is_err());
}

#[test]
fn c3_the_same_removal_through_a_grammar_that_does_not_widen_gives_the_document_back() {
    // The pair that gives the test above its teeth: same document, same trace,
    // an inverse that takes only what it was asked to. A post-condition that
    // refused every removal would pass the first test and make permanently
    // unremovable everything this product has ever posed.
    let removed = unmerge::<Jsonc>(DOCUMENT, &trace()).expect("the nominal removal must succeed");

    assert!(
        removed.contains("docs/rules.md") && removed.contains("AGENTS.md"),
        "the values of the owner must survive the removal: {removed}"
    );
    assert!(
        removed.contains("// the owner wrote this"),
        "the comment of the owner must survive the removal: {removed}"
    );
    assert!(
        !removed.contains("statusLine"),
        "the removal must take back what the product posed: {removed}"
    );
}

#[test]
fn guard_the_comment_witness_sees_what_the_value_witness_cannot() {
    // Why there are two witnesses and not one. The comment the document carries
    // is not a leaf, so it appears in no enumeration of values: a removal that
    // destroyed it would leave the first witness silent, which is exactly how
    // an owner's annotation left a document with the byte count from before.
    let values = Jsonc::values(DOCUMENT).expect("the document must be readable");
    assert!(
        !values
            .iter()
            .any(|value| value.value() == &Value::text("// the owner wrote this")),
        "the comparison of values must be blind to a comment, or this pair measures nothing"
    );
    assert_eq!(
        Jsonc::comments(DOCUMENT).expect("the document must be readable"),
        vec!["// the owner wrote this".to_string()],
        "and the second witness must see it"
    );
}

#[test]
fn c3_a_removal_from_an_array_accounts_for_the_values_it_added_and_not_for_the_path() {
    // The values of the product and the values of its owner live at the **same
    // path** in an array. Accounting for the path rather than for the values
    // would let a removal empty the array with the post-condition looking on,
    // and that is not a hypothetical: removing a string is done by value
    // equality, so nothing but the values themselves tells the two apart.
    let refusal = unmerge::<WideningRemoval>(
        DOCUMENT,
        &Inverse::Values {
            path: vec!["instructions".to_string()],
            added: vec!["AGENTS.md".to_string()],
        },
    )
    .expect_err("a value of the owner left the array without anything going red");

    match &refusal {
        MergeError::RemovalLostValues { lost, .. } => {
            assert_eq!(lost.len(), 1, "{lost:?}");
            assert_eq!(lost[0].path(), "instructions");
            assert_eq!(
                lost[0].value(),
                &Value::text("docs/rules.md"),
                "the value the trace named must be accounted for, and only it"
            );
        }
        other => panic!("the refusal does not come from the post-condition: {other:?}"),
    }
}

/// The twin of the identity gap `element_identity.rs` closed for
/// `Inverse::Element`, on the other trace shape `accounted_for` handles: a
/// value named by equality rather than an element named by identity.
///
/// **The gap, measured.** `accounted_for`'s `Values` arm pushed every value
/// the trace recorded into the account without ever reading `source` — the
/// same document `unmerge` had just parsed to compute `before`. A value the
/// owner had since deleted was accounted for anyway, `before` never held it
/// so `values_lost(before, after)` had nothing to compare it against, and the
/// post-condition — built entirely from that diff — had nothing to catch.
/// `unmerge` returned `Ok` on a document its removal never touched.
#[test]
fn guard_unmerge_refuses_a_value_removal_when_the_owner_has_already_removed_it() {
    // GIVEN a value the product poses into an array the owner already writes.
    const BEFORE: &str = concat!("{\n", "\t\"instructions\": [\"AGENTS.md\"]\n", "}\n",);
    let merged = merge::<Jsonc>(BEFORE, &Edit::values(&["instructions"], ["posed.md"]))
        .expect("the pose must succeed");
    assert!(
        merged.rendered.contains("posed.md"),
        "the fixture must actually pose the value, or this test measures nothing: {}",
        merged.rendered
    );

    // AND the owner has since edited the document by hand: the posed value is
    // gone, and the owner's own new entry sits where it used to be. Nothing
    // here replays the pose — this is an independent edit, the way an owner's
    // edit always is.
    const OWNER_EDITED: &str = concat!(
        "{\n",
        "\t\"instructions\": [\"AGENTS.md\", \"user-added.md\"]\n",
        "}\n",
    );

    // WHEN unmerge replays the pose's trace against the document the owner
    // produced, where the posed value is no longer there to take back.
    let verdict = unmerge::<Jsonc>(OWNER_EDITED, &merged.inverse);

    // THEN it refuses, naming what the trace no longer finds, rather than
    // reporting a removal done on a document it never touched.
    assert!(
        verdict.is_err(),
        "unmerge must refuse a value the document no longer carries, but returned {verdict:?}"
    );
    let message = verdict.unwrap_err().to_string();
    for expected in ["instructions", "posed.md"] {
        assert!(
            message.contains(expected),
            "the refusal does not name {expected:?}: {message}"
        );
    }

    // AND the owner's own entry survived being asked about: this is a refusal,
    // not a removal that landed with the wrong verdict.
    assert!(
        OWNER_EDITED.contains("user-added.md"),
        "the fixture must carry the owner's own entry, or this test measures nothing"
    );
}
