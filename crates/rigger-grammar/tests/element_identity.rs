//! An element of a list of objects, found again by its identity — C5: **an
//! element is found again by the identity the product lodges inside it**, never
//! by its rank, which a reordering destroys, and never by its value, which the
//! catalogue is free to change.
//!
//! **Why the identity lives inside the element, and why that is not a
//! preference.** Measured on 2026-08-06 on the host that is served: it rewrites
//! its own settings through a round trip across a typed model. A key it does
//! not know is **destroyed at the root of the document** and **preserved inside
//! an object element**. An identity written beside the element would therefore
//! be wiped by the first configuration command its owner runs, and the element
//! would become impossible to find again — hence impossible to remove.
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
use rigger_grammar::{
    merge, unmerge, Applied, Edit, ElementUndo, Grammar, GrammarError, GrammarRole, Inverse, Jsonc,
    MergeError, Probe, Resolution, SemanticValue, Value,
};

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

/// Declares a grammar that reads, enumerates and writes exactly as JSONC does,
/// save for the one thing the post-conditions of a removal judge: what the write
/// actually leaves in the document.
///
/// **Why the seam is a grammar and not a fixture.** Both post-conditions bear on
/// the output, and a test can only show that by handing in a write that every
/// input check accepts and that is wrong anyway — the element is found, its
/// identity is unique, the fields are read, and then the write does something
/// else. No document produces that, because the honest write is right on all of
/// them. So the write itself is what has to be replaced, and the removal being
/// generic over its grammar, a test grammar is the whole seam: production keeps
/// exactly **one** write path, which is the property the removal rests on.
macro_rules! grammar_whose_write {
    ($name:ident, $render:expr) => {
        struct $name;

        impl Grammar for $name {
            const NAME: &'static str = Jsonc::NAME;
            const ROLE: GrammarRole = Jsonc::ROLE;
            const RESOLUTION: Resolution = Jsonc::RESOLUTION;
            const PROBE: Probe = Jsonc::PROBE;

            fn round_trip(source: &str) -> Result<String, GrammarError> {
                Jsonc::round_trip(source)
            }

            fn find_string_in_list(
                source: &str,
                path: &[&str],
                value: &str,
            ) -> Result<bool, GrammarError> {
                Jsonc::find_string_in_list(source, path, value)
            }

            fn find_element_by_identity(
                source: &str,
                path: &[String],
                identity: &Marker,
            ) -> Result<Option<Vec<(String, Value)>>, GrammarError> {
                Jsonc::find_element_by_identity(source, path, identity)
            }

            fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
                Jsonc::apply(source, edit)
            }

            fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
                let render: fn(&str, String) -> String = $render;
                Ok(render(source, Jsonc::invert(source, inverse)?))
            }

            fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
                Jsonc::values(source)
            }
        }
    };
}

grammar_whose_write!(WriteThatTouchesNothing, |source, _honest| source
    .to_string());

grammar_whose_write!(WriteThatAlsoTakesTheModelAway, |_source, honest| honest
    .replace("  \"model\": \"acme/model-small\",\n", ""));

/// The values a refusal names, in a form a failure message can compare.
fn lost(values: &[SemanticValue]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

/// A write that takes the element away and one of its owner's values with it —
/// a value the trace does not record and the divergence report does not name.
/// The element does go, so reading it back finds nothing; the only property left
/// that tells this apart from a clean removal is accounting for what disappeared
/// against what the removal is able to name.
#[test]
fn c5_a_removal_that_destroys_a_value_it_cannot_name_is_refused() {
    let error = element::remove::<WriteThatAlsoTakesTheModelAway>(
        REWRITTEN_BY_THE_HOST,
        &trace("scripts/guard.sh"),
    )
    .expect_err("the write destroyed a value neither the trace nor the report accounts for");

    match &error {
        RemoveError::ValuesLost {
            identity: named,
            lost: values,
        } => {
            assert_eq!(*named, identity());
            assert_eq!(lost(values), ["model = \"acme/model-small\""]);
        }
        other => panic!("the refusal must name the value that disappeared, got {other:?}"),
    }
    let message = error.to_string();
    assert!(
        message.contains("acme/model-small") && message.contains("model ="),
        "the refusal must name the value and its path: {message}"
    );
}

/// A write that does not touch the source at all destroys no value, so the
/// accounting above stays silent — the only property left that tells this apart
/// from a real removal is looking the identity up again in the rendering and
/// finding it still there. Reporting the entry as removed would leave an element
/// nothing will ever remove again, since the registry would have forgotten it.
#[test]
fn c5_a_removal_whose_write_left_the_element_in_the_list_is_reported_still_present() {
    let error = element::remove::<WriteThatTouchesNothing>(
        REWRITTEN_BY_THE_HOST,
        &trace("scripts/guard.sh"),
    )
    .expect_err("a write that leaves the element in the list must not be reported as done");

    match &error {
        RemoveError::StillPresent {
            identity: found,
            path,
        } => {
            assert_eq!(*found, identity());
            assert_eq!(path, "hooks");
        }
        other => panic!("the refusal must report the element as still present, got {other:?}"),
    }
    let message = error.to_string();
    assert!(
        message.contains("hooks") && message.contains(&identity().to_string()),
        "the refusal must name the list and the identity: {message}"
    );
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
///
/// **The refusal is named, and that is what this guard holds.** Such a fragment
/// is turned back twice over, and only the first refusal is the rule. Take the
/// reserved-field check away and the write still fails, further down and for
/// another reason: the appended element then carries `agent-rigger` twice, the
/// merge post-condition runs the inverse on its own rendering, and the read
/// refuses a key defined twice on the path it is reading. Asserting only "some
/// grammar refusal happened" therefore passes on that accident, and the field
/// would be reserved in prose alone.
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
    match &failure {
        MergeError::Grammar(GrammarError::ReservedField { grammar, field }) => {
            assert_eq!(*grammar, Jsonc::NAME);
            assert_eq!(*field, element::IDENTITY_KEY);
        }
        other => panic!(
            "the refusal must name the reserved field the fragment declared, and not come from \
             some later check that happens to turn this write back too: {other:?}"
        ),
    }
}

/// A list holding one single element, whose `agent-rigger` field carries
/// `value` — written out by hand, so that the shape under that name is the
/// fixture and not something the crate rendered.
fn element_whose_identity_field_carries(value: &str) -> String {
    format!(
        concat!(
            "{{\n",
            "  \"hooks\": [\n",
            "    {{\n",
            "      \"agent-rigger\": {},\n",
            "      \"matcher\": \"Bash\",\n",
            "      \"command\": \"scripts/guard.sh\"\n",
            "    }}\n",
            "  ]\n",
            "}}\n",
        ),
        value
    )
}

/// Guard, not scenario: the product writes the identity as a **string** and as
/// nothing else, so an element carrying any other shape under that name was not
/// written by it. Claiming such an element would be claiming bytes somebody else
/// wrote — and then removing them.
///
/// The shapes tried are every one a JSON document can put there beside a
/// string, and each is tried on both sides of the claim: a removal must not find
/// the element, and a pose must add its own element beside it rather than write
/// into it.
#[test]
fn guard_an_element_whose_identity_field_is_not_a_string_is_not_claimed() {
    for shape in [
        "42",
        "true",
        "{ \"catalogue\": \"jr-catalogue\", \"entry\": \"hooks/guard\" }",
        "[\"catalogue=jr-catalogue entry=hooks/guard\"]",
        "null",
    ] {
        let document = element_whose_identity_field_carries(shape);

        // The removal does not claim it: no element of the list carries the
        // identity, and the refusal says so rather than take the nearest thing.
        let failure = element::remove::<Jsonc>(&document, &trace("scripts/guard.sh"))
            .err()
            .unwrap_or_else(|| panic!("the removal claimed an element carrying {shape}"));
        assert!(
            matches!(failure, RemoveError::NotFound { .. }),
            "the identity is carried by no element, and {shape} is not it: {failure:?}"
        );

        // And the pose does not claim it either: it appends an element of its
        // own, carrying the identity as a string, and leaves the list one
        // element longer than it found it.
        let posed = merge::<Jsonc>(&document, &published("scripts/guard.sh"))
            .expect("the pose must succeed")
            .rendered;
        assert!(
            posed.contains(POSED_IDENTITY),
            "the pose wrote into the element carrying {shape} instead of posing its own: {posed}"
        );
        assert_eq!(
            posed.matches("\"matcher\"").count(),
            2,
            "the list does not hold the element carrying {shape} and the posed one: {posed}"
        );
        assert!(
            posed.contains(&format!("\"agent-rigger\": {shape}")),
            "the element the product never wrote lost what it carried: {posed}"
        );
    }
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

// --- Differential guard: `element::remove` against `unmerge` ---------------
//
// Both undo the same pose of the same element, through the same writer:
// `element::remove` (element.rs:261) builds `Inverse::Element { .. undo:
// ElementUndo::Remove }` on the spot and calls `G::invert`; `unmerge`
// (merge.rs:285) receives exactly that value and calls `G::invert` too. The
// bytes they render are therefore identical by construction; only the
// bookkeeping each one runs around that write — `element::accounted`
// (element.rs:354-371) against `merge::accounted_for`'s `Element`/`Remove`
// arm (merge.rs:392-404) — can differ. Twelve tests above exercise the first
// path, four exercise the second; none had ever compared them before the
// guards below.

/// The same document once its owner has removed a field the product wrote,
/// keeping only what they still wanted from the element.
const FIELD_REMOVED_BY_ITS_OWNER: &str = concat!(
    "{\n",
    "  \"model\": \"acme/model-small\",\n",
    "  \"hooks\": [\n",
    "    {\n",
    "      \"agent-rigger\": \"catalogue=jr-catalogue entry=hooks/guard\",\n",
    "      \"command\": \"scripts/guard.sh\"\n",
    "    },\n",
    "    {\n",
    "      \"matcher\": \"Write\",\n",
    "      \"command\": \"scripts/mine.sh\"\n",
    "    }\n",
    "  ]\n",
    "}\n",
);

/// The value both removal paths write through, built from `ElementTrace`'s
/// own `pub` accessors rather than duplicated by hand — the same value
/// `element::remove` constructs right before calling `G::invert`
/// (element.rs:276-283) and `unmerge` receives unchanged (merge.rs:285,
/// merge.rs:294).
fn inverse_of(trace: &ElementTrace) -> Inverse {
    Inverse::Element {
        path: trace.path().to_vec(),
        identity: trace.identity().clone(),
        undo: ElementUndo::Remove,
    }
}

#[test]
fn guard_element_remove_and_unmerge_write_the_same_bytes_from_the_same_write() {
    // [POSITIVE CONTROL] The write itself cannot differ between the two
    // paths — only the accounting run around it can. A divergence here
    // indicts this guard's own wiring, not the two removal paths it compares.
    let element_bytes = element::remove::<Jsonc>(REWRITTEN_BY_THE_HOST, &trace("scripts/guard.sh"))
        .expect("the element must be found on this document")
        .rendered;
    let unmerge_bytes = unmerge::<Jsonc>(
        REWRITTEN_BY_THE_HOST,
        &inverse_of(&trace("scripts/guard.sh")),
    )
    .expect("the same element, found by the same identity, must be removable the same way");

    assert_eq!(
        element_bytes, unmerge_bytes,
        "both paths call `Grammar::invert` on the same `Inverse::Element` value and must \
         therefore render identical bytes"
    );
}

#[test]
fn guard_element_remove_and_unmerge_agree_on_the_verdict_when_the_element_is_not_found() {
    // Same document, same identity, the same constructed `Inverse::Element`
    // value on both sides — this asserts the two paths reach the **same**
    // verdict. `element::remove` looks the identity up before writing
    // anything (element.rs:264-269) and refuses by name — `RemoveError::
    // NotFound` — when no element carries it, which SETTINGS never did.
    // Whether `unmerge` refuses too is exactly what this guard exists to
    // measure, not assume: if it does not, the assertion below is the
    // failure, and the failure is the finding — it is not corrected by
    // loosening what "agree" means here.
    let element_verdict = element::remove::<Jsonc>(SETTINGS, &trace("scripts/guard.sh"));
    assert!(
        matches!(element_verdict, Err(RemoveError::NotFound { .. })),
        "element::remove must refuse an identity no element carries: {element_verdict:?}"
    );

    let unmerge_verdict = unmerge::<Jsonc>(SETTINGS, &inverse_of(&trace("scripts/guard.sh")));
    assert!(
        unmerge_verdict.is_err(),
        "unmerge must refuse the same identity too, but returned {unmerge_verdict:?} — \
         `accounted_for`'s `Element`/`Remove` arm (merge.rs:392-404) runs no lookup equivalent \
         to `element::remove`'s and stays empty when nothing is found, `Jsonc::invert` then finds \
         no element to remove and hands the document back untouched (jsonc.rs:308-310), and since \
         nothing disappeared between `before` and `after` the post-condition has nothing to \
         catch — unmerge reports a removal DONE on a document it never touched"
    );
}

/// A grammar whose write path matches JSONC except that removing an element
/// also erases the `model` field at the root of the document — the same
/// cross-cutting loss the existing guard
/// `c5_a_removal_that_destroys_a_value_it_cannot_name_is_refused` already
/// proves `element::remove` catches. Declared again here, rather than reused,
/// because it must implement [`Grammar::comments`]: `unmerge` reads it before
/// its `ValuesLost` witness even runs (merge.rs:287), and a grammar that
/// leaves it unimplemented would make `unmerge` fail with `MergeError::
/// Grammar(GrammarError::Unsupported)` — a witness the other path lacks, not
/// the accounting disagreement this test means to compare.
struct WideningElementRemoval;

impl Grammar for WideningElementRemoval {
    const NAME: &'static str = Jsonc::NAME;
    const ROLE: GrammarRole = Jsonc::ROLE;
    const RESOLUTION: Resolution = Jsonc::RESOLUTION;
    const PROBE: Probe = Jsonc::PROBE;

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Jsonc::round_trip(source)
    }

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        Jsonc::find_string_in_list(source, path, value)
    }

    fn find_element_by_identity(
        source: &str,
        path: &[String],
        identity: &Marker,
    ) -> Result<Option<Vec<(String, Value)>>, GrammarError> {
        Jsonc::find_element_by_identity(source, path, identity)
    }

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        Jsonc::apply(source, edit)
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        Ok(Jsonc::invert(source, inverse)?.replace("  \"model\": \"acme/model-small\",\n", ""))
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Jsonc::values(source)
    }

    fn comments(source: &str) -> Result<Vec<String>, GrammarError> {
        Jsonc::comments(source)
    }
}

#[test]
fn guard_element_remove_and_unmerge_agree_on_a_genuine_cross_cutting_value_loss() {
    // Where the guard above disagrees, this one must not: a write that
    // destroys a value belonging to nobody the trace names. The two error
    // variants are named explicitly, never through `is_err()`, because
    // `RemoveError::ValuesLost` and `MergeError::RemovalLostValues` are the
    // twin this comparison exists to tell apart from `MergeError::ValuesLost`
    // (which accuses a pose, not a removal) and from `MergeError::
    // RemovalLostComments` (the other witness — ruled out here by giving
    // `WideningElementRemoval` a real `comments` implementation).
    let element_error = element::remove::<WideningElementRemoval>(
        REWRITTEN_BY_THE_HOST,
        &trace("scripts/guard.sh"),
    )
    .expect_err("the write destroyed a value neither the trace nor the report accounts for");
    match &element_error {
        RemoveError::ValuesLost {
            identity: found,
            lost: disappeared,
        } => {
            assert_eq!(*found, identity());
            assert_eq!(lost(disappeared), ["model = \"acme/model-small\""]);
        }
        other => panic!("element::remove must name the value the write destroyed: {other:?}"),
    }

    let unmerge_error = unmerge::<WideningElementRemoval>(
        REWRITTEN_BY_THE_HOST,
        &inverse_of(&trace("scripts/guard.sh")),
    )
    .expect_err("the same write must be refused through unmerge too");
    match &unmerge_error {
        MergeError::RemovalLostValues {
            grammar,
            lost: disappeared,
        } => {
            assert_eq!(*grammar, Jsonc::NAME);
            assert_eq!(lost(disappeared), ["model = \"acme/model-small\""]);
        }
        other => panic!(
            "unmerge must name the same value through its own twin refusal, \
             `RemovalLostValues`, not {other:?}"
        ),
    }
}

#[test]
fn guard_element_remove_and_unmerge_agree_when_only_the_owner_touched_the_element() {
    // [KNOWN DIVERGENCES #1 AND #2, checked here and found inert]
    // `element::accounted` (element.rs:354-371) credits every field the trace
    // recorded as written, unconditionally, **plus** whatever the divergence
    // report names as currently found — so a field the owner modified is
    // credited twice (the value the product wrote, and the value now on
    // disk) and a field the owner deleted is credited once, for a value no
    // longer anywhere in the document. `merge::accounted_for`'s `Element`/
    // `Remove` arm (merge.rs:392-404) has no trace fields to draw on and
    // credits only what `find_element_by_identity` reads off the document as
    // it stands.
    //
    // Neither extra credit changes a verdict on the two documents below, and
    // the reason is the same for both: a value already absent, or already
    // replaced, before the removal runs is not part of `before`
    // (`Grammar::values(source)`) to begin with, so it can never surface in
    // `values_lost(before, after)` for the two accountings to disagree about.
    // The extra credit would only matter if it also happened to cover the
    // disappearance of an *identical* value belonging to a neighbouring
    // element — the collision the guard above manufactures on purpose with a
    // widening grammar. Neither document here produces that collision by
    // itself, so this result is corpus absence, not unreachability: the
    // mechanism that would make the divergence observable is confirmed
    // present in the source cited above, and is exercised deliberately in the
    // guard above this one — just not by accident here.
    for (case, document) in [
        ("a field the owner modified", EDITED_BY_ITS_OWNER),
        ("a field the owner deleted", FIELD_REMOVED_BY_ITS_OWNER),
    ] {
        let element_verdict = element::remove::<Jsonc>(document, &trace("scripts/guard.sh"));
        assert!(
            element_verdict.is_ok(),
            "element::remove refused on the case of {case}: {element_verdict:?}"
        );

        let unmerge_verdict = unmerge::<Jsonc>(document, &inverse_of(&trace("scripts/guard.sh")));
        assert!(
            unmerge_verdict.is_ok(),
            "unmerge refused on the case of {case}: {unmerge_verdict:?}"
        );
    }
}

/// D10 — `Jsonc::invert`'s `Element` arm, on its own, without going through
/// `unmerge`. An identity `identified_element` does not find used to fall
/// through to `Ok(root.to_string())` — the document handed back unchanged —
/// instead of refusing, for **both** shapes of `ElementUndo`: a whole element
/// created by the pose (`Remove`) or fields updated inside one it did not
/// create (`Restore`). This test drives the check with a `Restore` trace,
/// because that is the shape whose caller-side guard turns out not to hold —
/// see the guard below.
#[test]
fn guard_invert_refuses_an_element_update_the_document_no_longer_carries() {
    // GIVEN a hook posed once, then updated: the update's inverse is a
    // `Restore`, naming only the fields it touched inside an element it did
    // not create.
    let posed = merge::<Jsonc>(SETTINGS, &published("scripts/guard.sh"))
        .expect("the pose must succeed")
        .rendered;
    let updated =
        merge::<Jsonc>(&posed, &published("scripts/guard-2.sh")).expect("the update must succeed");
    assert!(
        matches!(
            &updated.inverse,
            Inverse::Element {
                undo: ElementUndo::Restore { .. },
                ..
            }
        ),
        "the fixture must produce a `Restore` inverse, or this test measures nothing: {:?}",
        updated.inverse
    );

    // AND the document the trace is replayed against never carried the
    // identity at all — stands for an owner who deleted the element outright.
    assert!(
        !SETTINGS.contains(&identity().to_string()),
        "the fixture must not carry the identity, or this test measures nothing"
    );

    // WHEN `invert` replays that trace directly, with no `accounted_for` and
    // no caller-side lookup standing in front of it.
    let refusal = Jsonc::invert(SETTINGS, &updated.inverse)
        .expect_err("an element the document no longer carries must not be silently skipped");

    // THEN it names the list and the identity, rather than handing the
    // document back untouched.
    match &refusal {
        GrammarError::ElementNotFound {
            path,
            identity: found,
            ..
        } => {
            assert_eq!(path, "hooks");
            assert_eq!(found, &identity().to_string());
        }
        other => panic!("the refusal does not name what is missing: {other:?}"),
    }
}

/// D10's own finding, re-verifying the 2026-08-12 analysis that `unmerge`
/// always calls `accounted_for` before `invert`, so the silent skip above is
/// inert in practice: true as an order, false as a guarantee. `accounted_for`'s
/// `Element`/`Restore` arm (merge.rs:422-433) builds its `places` from the
/// field names the trace recorded and — unlike its `Remove` sibling three
/// lines above — never looks the identity up on `source`. Before this slice,
/// an element the owner had deleted outright therefore sailed through
/// `accounted_for` unaccounted-for-nothing, reached `invert`'s silent skip,
/// and came back as `Ok` on a document the write never touched. The fix
/// above closes this from the inside — `invert` itself now refuses — so this
/// guard passes regardless of what `accounted_for` does or does not check.
#[test]
fn guard_unmerge_refuses_an_element_update_when_the_owner_has_deleted_the_element() {
    // GIVEN the same `Restore`-shaped update as the guard above.
    let posed = merge::<Jsonc>(SETTINGS, &published("scripts/guard.sh"))
        .expect("the pose must succeed")
        .rendered;
    let updated =
        merge::<Jsonc>(&posed, &published("scripts/guard-2.sh")).expect("the update must succeed");
    assert!(
        matches!(
            &updated.inverse,
            Inverse::Element {
                undo: ElementUndo::Restore { .. },
                ..
            }
        ),
        "the fixture must produce a `Restore` inverse, or this test measures nothing: {:?}",
        updated.inverse
    );

    // WHEN `unmerge` replays that trace against a document that never carried
    // the element — an owner's edit, the way an owner's edit always is.
    let verdict = unmerge::<Jsonc>(SETTINGS, &updated.inverse);

    // THEN it refuses, naming what the trace no longer finds, rather than
    // reporting an update done on a document it never touched.
    assert!(
        verdict.is_err(),
        "unmerge must refuse an element update the document no longer carries, but returned \
         {verdict:?}"
    );
}
