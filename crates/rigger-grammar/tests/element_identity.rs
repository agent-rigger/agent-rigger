//! An element of a list of objects, found again by its identity. Scenarios of
//! `docs/specs/socle-neuf/requirements.md` § C5.
//!
//! **Why the identity lives inside the element, and why that is not a
//! preference.** Measured on 2026-08-06 on the host that is served
//! (`docs/specs/socle-neuf/reconnaissance-hotes.md`): it rewrites its own
//! settings through a round trip across a typed model. A key it does not know
//! is **destroyed at the root of the document** and **preserved inside an
//! object element**. An identity written beside the
//! element would therefore be wiped by the first configuration command its
//! owner runs, and the element would become impossible to find again — hence
//! impossible to remove.
//!
//! **The fixtures are written by hand, and the identity syntax with them.**
//! Asking the crate to render the documents these tests read would make them
//! agree with the implementation by construction, and a search that only ever
//! meets its own output is a search nobody measured. What the host does to a
//! document is transcribed here from that measurement, never generated.
//!
//! Tests prefixed with an identifier realise the scenario of that requirement;
//! those prefixed with `guard_` realise none, and check that the scenarios
//! still measure something.

use rigger_grammar::element::{self, ElementTrace, FieldDivergence, RemoveError};
use rigger_grammar::marker::Marker;
use rigger_grammar::{merge, Edit, Grammar, Jsonc, MergeError, Value};

/// The identity of the entry this catalogue poses.
fn identity() -> Marker {
    Marker::new("jr-catalogue", "hooks/guard")
}

/// Another catalogue publishing an entry of the **same name**. Two independent
/// authors will choose `hooks/guard`; what tells their elements apart is the
/// provenance, and nothing else.
fn homonym() -> Marker {
    Marker::new("acme-catalogue", "hooks/guard")
}

/// The identity as a document carries it, written out by hand.
const POSED_IDENTITY: &str = "\"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\"";

/// A settings document as a user holds it: indented with tabs, carrying an
/// end-of-line comment, and a list whose elements are objects — one of which
/// the user wrote themselves.
const SETTINGS: &str = concat!(
    "{\n",
    "\t\"model\": \"acme/model-small\", // personal — do not touch\n",
    "\t\"hooks\": [\n",
    "\t\t{ \"matcher\": \"Write\", \"command\": \"scripts/mine.sh\" }\n",
    "\t]\n",
    "}\n",
);

/// What the catalogue publishes for that entry.
fn published(command: &str) -> Edit {
    Edit::element(
        &["hooks"],
        identity(),
        [
            ("matcher", Value::text("Bash")),
            ("command", Value::text(command)),
        ],
    )
}

/// What the registry records of that pose, so that a removal can replay it.
fn trace(command: &str) -> ElementTrace {
    ElementTrace::new(
        &["hooks"],
        identity(),
        [
            ("matcher", Value::text("Bash")),
            ("command", Value::text(command)),
        ],
    )
}

/// The semantic values of a document, each with its path, in a form comparable
/// inside a failure message.
fn values(source: &str) -> Vec<String> {
    Jsonc::values(source)
        .expect("the document must be readable")
        .iter()
        .map(|value| value.to_string())
        .collect()
}

/// How many times the identity appears in a rendering, counted on the bytes
/// rather than through the crate's own search: a second element would be a
/// second occurrence, whatever the implementation believes.
fn occurrences(rendered: &str, identity: &Marker) -> usize {
    rendered.matches(&identity.to_string()).count()
}

#[test]
fn c5_an_element_is_found_again_by_its_identity_when_its_value_changed() {
    // GIVEN a hook posed by the product.
    let posed = merge::<Jsonc>(SETTINGS, &published("scripts/guard.sh"))
        .expect("the pose must succeed")
        .rendered;
    assert_eq!(
        occurrences(&posed, &identity()),
        1,
        "the pose did not write the identity once: {posed}"
    );

    // WHEN the catalogue publishes a different command and the update runs.
    let updated = merge::<Jsonc>(&posed, &published("scripts/guard-2.sh"))
        .expect("the update must succeed")
        .rendered;

    // THEN the element was found again by its identity: its command carries the
    // new value, and the old one is gone.
    assert!(
        values(&updated).contains(&"hooks.command = \"scripts/guard-2.sh\"".to_string()),
        "the updated element does not carry the new command: {:?}",
        values(&updated)
    );
    assert!(
        !updated.contains("scripts/guard.sh\""),
        "the command from before survives alongside the new one: {updated}"
    );

    // AND one single element carries that identity after the update, never two.
    assert_eq!(
        occurrences(&updated, &identity()),
        1,
        "the update appended a second element instead of finding the first: {updated}"
    );
    assert_eq!(
        updated.matches("\"matcher\"").count(),
        SETTINGS.matches("\"matcher\"").count() + 1,
        "the list holds more elements than the user's one and the posed one: {updated}"
    );

    // AND the element the user wrote was not touched.
    assert!(
        updated.contains("{ \"matcher\": \"Write\", \"command\": \"scripts/mine.sh\" }"),
        "the user's element was rewritten: {updated}"
    );
}

#[test]
fn c5_the_identity_is_written_inside_the_element_and_never_at_the_root() {
    // GIVEN the same pose.
    let posed = merge::<Jsonc>(SETTINGS, &published("scripts/guard.sh"))
        .expect("the pose must succeed")
        .rendered;

    // THEN the identity lives at the path of the list, that is, inside one of
    // its elements — and no value of the document lives at the root under that
    // name. A root key is what the host destroys, so an identity written there
    // would not survive the next configuration command.
    let carried = values(&posed);
    assert!(
        carried.contains(&format!(
            "hooks.{} = \"{}\"",
            element::IDENTITY_KEY,
            identity()
        )),
        "the identity is not inside an element of the list: {carried:?}"
    );
    assert!(
        !carried
            .iter()
            .any(|value| value.starts_with(&format!("{} =", element::IDENTITY_KEY))),
        "the identity was written at the root of the document: {carried:?}"
    );
}

/// The document before the host touched it: tab indentation, the whole list on
/// one line, and the identity written **twice** — once at the root, once inside
/// the element.
const BEFORE_THE_HOST_REWROTE_IT: &str = concat!(
    "{\n",
    "\t\"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\",\n",
    "\t\"model\": \"acme/model-small\",\n",
    "\t\"hooks\": [{ \"matcher\": \"Write\", \"command\": \"scripts/mine.sh\" }, ",
    "{ \"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\", ",
    "\"matcher\": \"Bash\", \"command\": \"scripts/guard.sh\" }]\n",
    "}\n",
);

/// The same document once the host has rewritten it, transcribed from the
/// measurement of 2026-08-06 on the host that is served: the key it does not
/// know is destroyed **at the root** and preserved **inside the element**, tab
/// indentation is replaced by two spaces, and the one-line list is redeployed
/// over several. The element order is reversed too — the host reconstructs the
/// shape it knows, and nothing promises it does so in place.
const REWRITTEN_BY_THE_HOST: &str = concat!(
    "{\n",
    "  \"model\": \"acme/model-small\",\n",
    "  \"hooks\": [\n",
    "    {\n",
    "      \"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\",\n",
    "      \"matcher\": \"Bash\",\n",
    "      \"command\": \"scripts/guard.sh\"\n",
    "    },\n",
    "    {\n",
    "      \"matcher\": \"Write\",\n",
    "      \"command\": \"scripts/mine.sh\"\n",
    "    }\n",
    "  ]\n",
    "}\n",
);

#[test]
fn c5_the_identity_survives_the_rewriting_of_the_document_by_its_host() {
    // GIVEN an element posed with its identity, in a document the host then
    // rewrites. The fixture is the measurement itself: what the host destroys
    // at the root, it preserves inside the element.
    assert!(
        BEFORE_THE_HOST_REWROTE_IT.contains(&format!("\t{POSED_IDENTITY}")),
        "the fixture must carry the identity at the root before the rewrite, \
         failing which this scenario measures a document that merely looks different"
    );
    assert!(
        !REWRITTEN_BY_THE_HOST.contains(&format!("  {POSED_IDENTITY},\n  \"model\"")),
        "the fixture must have the root identity destroyed by the rewrite"
    );
    assert!(
        BEFORE_THE_HOST_REWROTE_IT.contains(POSED_IDENTITY)
            && REWRITTEN_BY_THE_HOST.contains(POSED_IDENTITY),
        "the fixture must carry the identity inside the element on both sides"
    );

    // WHEN the product reads the document again.
    // THEN the identity is still inside the element, and nowhere else.
    let carried = values(REWRITTEN_BY_THE_HOST);
    assert!(
        carried.contains(&format!(
            "hooks.{} = \"{}\"",
            element::IDENTITY_KEY,
            identity()
        )),
        "the identity is no longer inside the element after the rewrite: {carried:?}"
    );
    assert!(
        !carried
            .iter()
            .any(|value| value.starts_with(&format!("{} =", element::IDENTITY_KEY))),
        "the identity at the root survived the rewrite, which the measurement denies: {carried:?}"
    );

    // AND the removal finds the element — although the host moved it to another
    // rank, replaced the indentation and redeployed the list.
    let removed = element::remove::<Jsonc>(REWRITTEN_BY_THE_HOST, &trace("scripts/guard.sh"))
        .expect("the removal must find the element again after the rewrite");
    assert!(
        removed.diverged.is_empty(),
        "the rewrite was reported as a divergence of content: {:?}",
        removed.diverged
    );
    assert!(
        !removed.rendered.contains(&identity().to_string()),
        "the element is still in the list after removal: {}",
        removed.rendered
    );
    assert!(
        removed.rendered.contains("scripts/mine.sh"),
        "the element the user wrote left with the posed one: {}",
        removed.rendered
    );
}

/// The same document once its owner has edited the command of the posed
/// element, and added a field of their own to it.
const EDITED_BY_ITS_OWNER: &str = concat!(
    "{\n",
    "  \"model\": \"acme/model-small\",\n",
    "  \"hooks\": [\n",
    "    {\n",
    "      \"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\",\n",
    "      \"matcher\": \"Bash\",\n",
    "      \"command\": \"scripts/guard.sh --my-flag\",\n",
    "      \"note\": \"mine, I changed the flag\"\n",
    "    },\n",
    "    {\n",
    "      \"matcher\": \"Write\",\n",
    "      \"command\": \"scripts/mine.sh\"\n",
    "    }\n",
    "  ]\n",
    "}\n",
);

/// The fields a report names, in a form a failure message can compare.
fn named(diverged: &[FieldDivergence]) -> Vec<String> {
    diverged.iter().map(|field| field.to_string()).collect()
}

#[test]
fn c5_a_removal_names_the_field_whose_value_its_owner_changed() {
    // GIVEN a posed element whose command its owner then edited.
    // WHEN the removal runs.
    let removed = element::remove::<Jsonc>(EDITED_BY_ITS_OWNER, &trace("scripts/guard.sh"))
        .expect("the removal must find the element by its identity");

    // THEN the element was found by its identity, and it is gone.
    assert!(
        !removed.rendered.contains(&identity().to_string()),
        "the element is still in the list: {}",
        removed.rendered
    );

    // AND the removal reports that the content had diverged, **by naming it**:
    // the field, what the product wrote, and what the document carried.
    let report = named(&removed.diverged);
    let command = report
        .iter()
        .find(|line| line.contains("command"))
        .unwrap_or_else(|| panic!("the report does not name the edited field: {report:?}"));
    assert!(
        command.contains("scripts/guard.sh --my-flag"),
        "the report does not say what the document carried: {command}"
    );
    assert!(
        command.contains("scripts/guard.sh\"") || command.contains("scripts/guard.sh "),
        "the report does not say what the product had written: {command}"
    );

    // AND the field its owner added is named too. It is destroyed with the
    // element, so the only thing that keeps this from being a silent
    // destruction is that the report carries it.
    assert!(
        report.iter().any(|line| line.contains("note")),
        "the field the owner added to the element is not named: {report:?}"
    );

    // AND the matcher, which nobody touched, is not reported as diverged.
    assert!(
        !report.iter().any(|line| line.contains("matcher")),
        "a field nobody changed is reported as diverged: {report:?}"
    );
}

#[test]
fn c5_an_element_without_the_identity_of_the_product_is_not_claimed() {
    // GIVEN an element of the same list, written by the user, with no identity
    // of the product — and, beside it, one the product posed.
    // WHEN a removal runs.
    let removed = element::remove::<Jsonc>(REWRITTEN_BY_THE_HOST, &trace("scripts/guard.sh"))
        .expect("the removal must succeed");

    // THEN that element is intact, byte for byte, and every value it carried is
    // still a value of the document.
    assert!(
        removed.rendered.contains(concat!(
            "    {\n",
            "      \"matcher\": \"Write\",\n",
            "      \"command\": \"scripts/mine.sh\"\n",
            "    }\n",
        )),
        "the element the user wrote was rewritten or removed: {}",
        removed.rendered
    );
    for value in [
        "hooks.matcher = \"Write\"",
        "hooks.command = \"scripts/mine.sh\"",
    ] {
        assert!(
            values(&removed.rendered).contains(&value.to_string()),
            "the value {value} of the user's element disappeared: {:?}",
            values(&removed.rendered)
        );
    }
}

/// Guard, not scenario: two catalogues may legitimately publish an entry of the
/// same name. Were the identity derived from the entry alone, removing one
/// would take the other's element away — and the identity is precisely what
/// told them apart.
#[test]
fn guard_an_element_of_a_homonymous_catalogue_is_not_claimed() {
    let posed = merge::<Jsonc>(SETTINGS, &published("scripts/guard.sh"))
        .expect("the pose must succeed")
        .rendered;
    let both = merge::<Jsonc>(
        &posed,
        &Edit::element(
            &["hooks"],
            homonym(),
            [("command", Value::text("scripts/theirs.sh"))],
        ),
    )
    .expect("the second catalogue must be able to pose too")
    .rendered;
    assert_ne!(
        identity().to_string(),
        homonym().to_string(),
        "two homonymous entries produce the same identity, so nothing tells their elements apart"
    );

    let removed = element::remove::<Jsonc>(&both, &trace("scripts/guard.sh"))
        .expect("the removal must succeed");
    assert!(
        removed.rendered.contains(&homonym().to_string()),
        "removing one catalogue's element took the homonymous one away: {}",
        removed.rendered
    );
    assert!(
        removed.rendered.contains("scripts/theirs.sh"),
        "the other catalogue's element lost its value: {}",
        removed.rendered
    );
}

/// Guard, not scenario: nothing says which of two elements carrying the same
/// identity the product wrote, so it removes neither. Picking one would be
/// removing the wrong element from a list somebody else owns, which is the one
/// damage this crate treats as irreversible.
#[test]
fn guard_two_elements_carrying_the_same_identity_are_refused() {
    let duplicated = concat!(
        "{\n",
        "  \"hooks\": [\n",
        "    { \"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\", ",
        "\"command\": \"a.sh\" },\n",
        "    { \"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\", ",
        "\"command\": \"b.sh\" }\n",
        "  ]\n",
        "}\n",
    );

    let failure = element::remove::<Jsonc>(duplicated, &trace("a.sh"))
        .expect_err("the removal arbitrated between two elements carrying the same identity");
    let message = failure.to_string();
    for expected in ["jsonc", "hooks", &identity().to_string()] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }
    assert!(
        matches!(failure, RemoveError::Grammar(_)),
        "the refusal must come from the grammar: {failure:?}"
    );
}

/// Guard, not scenario: a fragment that could write the field carrying the
/// identity could forge one — or overwrite the one that tells another
/// catalogue's element apart from its own.
#[test]
fn guard_a_fragment_declaring_the_identity_field_is_refused() {
    let failure = merge::<Jsonc>(
        SETTINGS,
        &Edit::element(
            &["hooks"],
            identity(),
            [(
                element::IDENTITY_KEY,
                Value::text("catalogue=other entry=x"),
            )],
        ),
    )
    .expect_err("a fragment wrote the field reserved for the identity");
    let message = failure.to_string();
    for expected in ["jsonc", element::IDENTITY_KEY] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }
    assert!(
        matches!(failure, MergeError::Grammar(_)),
        "the refusal must come from the grammar: {failure:?}"
    );
}

/// Guard, not scenario: a removal that finds nothing does not guess. Reporting
/// the entry as removed would leave a machine that believes itself clean.
#[test]
fn guard_a_removal_that_finds_no_element_refuses_by_naming_it() {
    let failure = element::remove::<Jsonc>(SETTINGS, &trace("scripts/guard.sh"))
        .expect_err("a removal found an element that was never posed");
    let message = failure.to_string();
    for expected in ["hooks", &identity().to_string()] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }
    assert!(
        matches!(failure, RemoveError::NotFound { .. }),
        "the refusal must say the element was not found: {failure:?}"
    );
}
