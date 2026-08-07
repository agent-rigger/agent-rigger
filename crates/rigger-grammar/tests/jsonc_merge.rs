//! The `merge` slice on JSONC, in scenarios.
//!
//! A test prefixed with an identifier realises that requirement. C1 — outside
//! the trace, the document comes back byte for byte. C2 — the write operates on
//! the structure of the grammar, never on lines. C6 — in a list of strings an
//! element is found again by its **value**, which is a declared limit and not a
//! design. Those prefixed with `guard_` realise none, and check that the
//! scenarios still measure something.
//!
//! **What this file does not do, and where that lives.** The scenarios of C1, C2
//! and C8 that bear on the **disk** — the transaction aborting before the
//! document is replaced, the document from before found intact — live in
//! `rigger-apply`, the crate that carries the input and output. This one stays
//! pure: what it measures is the edit, the inverse and the post-condition, on
//! strings.
//!
//! **Locality is measured by subtraction, never by resemblance.** [`gap`] returns
//! what disappeared and what appeared between two renderings, with the longest
//! common prefix and the longest common suffix removed. A document re-emitted
//! whole makes the whole document come out on both sides; a local edit makes two
//! short fragments come out. That is stronger than an equality of the remainder,
//! which can be obtained by luck on a simple document.

use rigger_grammar::{merge, Edit, Grammar, Jsonc, MergeError, Value};

/// What disappeared and what appeared between `before` and `after`, with the
/// longest common prefix and the longest common suffix removed. The two
/// fragments returned are **contiguous** by construction: if either of them
/// carries a part of the document the edit was not to touch, then the rendering
/// moved it or rewrote it.
fn gap(before: &str, after: &str) -> (String, String) {
    let (a, b) = (before.as_bytes(), after.as_bytes());
    let prefix = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    let remainder = a.len().min(b.len()) - prefix;
    let suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count()
        .min(remainder);
    (
        String::from_utf8_lossy(&a[prefix..a.len() - suffix]).into_owned(),
        String::from_utf8_lossy(&b[prefix..b.len() - suffix]).into_owned(),
    )
}

/// The semantic values of a document, rendered in a form comparable inside a
/// failure message.
fn values(source: &str) -> Vec<String> {
    Jsonc::values(source)
        .expect("the document must be readable")
        .iter()
        .map(|value| value.to_string())
        .collect()
}

/// A settings document as a user holds it: indented with tabs, carrying an
/// end-of-line comment on a key the product does not touch.
const SETTINGS: &str = concat!(
    "{\n",
    "\t\"model\": \"acme/model-small\", // personal — do not touch\n",
    "\t\"permissions\": {\n",
    "\t\t\"deny\": [\"Bash(rm -rf *)\"]\n",
    "\t}\n",
    "}\n",
);

/// The same document, every line ending in CRLF.
const SETTINGS_CRLF: &str = concat!(
    "{\r\n",
    "\t\"model\": \"acme/model-small\", // personal — do not touch\r\n",
    "\t\"permissions\": {\r\n",
    "\t\t\"deny\": [\"Bash(rm -rf *)\"]\r\n",
    "\t}\r\n",
    "}\r\n",
);

/// The fragment the product merges in these scenarios: a key at the root, and
/// its value.
fn fragment() -> Edit {
    Edit::keys(&[], [("guard", Value::text("scripts/guard.sh"))])
}

#[test]
fn c1_the_comment_and_indentation_of_an_owned_document_survive() {
    // GIVEN a settings document indented with tabs, carrying an end-of-line
    // comment on a key the product does not touch.
    // WHEN the product merges its fragment into it.
    let merged = merge::<Jsonc>(SETTINGS, &fragment()).expect("the merge must succeed");

    // THEN the added key is present.
    assert!(
        values(&merged.rendered).contains(&"guard = \"scripts/guard.sh\"".to_string()),
        "the added key is absent from the rendering: {:?}",
        values(&merged.rendered)
    );

    // AND the rest of the document is identical byte for byte to what it was:
    // nothing disappeared, and what appeared is the fragment.
    let (disappeared, appeared) = gap(SETTINGS, &merged.rendered);
    assert_eq!(
        disappeared, "",
        "bytes outside the trace disappeared from the owned document"
    );
    assert!(
        appeared.contains("guard"),
        "what appeared is not the posed fragment: {appeared:?}"
    );
    assert!(
        merged.rendered.contains("// personal — do not touch"),
        "the end-of-line comment disappeared"
    );

    // AND the tabs were not replaced: those of the document from before are all
    // still there, and the only ones added come from the fragment.
    let tabs = |text: &str| text.matches('\t').count();
    assert_eq!(
        tabs(&merged.rendered) - tabs(&appeared),
        tabs(SETTINGS),
        "the tabs of the document from before did not all survive"
    );

    // AND the inverse returns the document from before, byte for byte.
    assert_eq!(
        Jsonc::invert(&merged.rendered, &merged.inverse).expect("the inverse must apply"),
        SETTINGS
    );
}

#[test]
fn c1_the_line_endings_of_a_crlf_document_survive() {
    // GIVEN an owned document whose line endings are all CRLF.
    let crlf_before = SETTINGS_CRLF.matches("\r\n").count();
    assert_eq!(
        SETTINGS_CRLF.matches('\n').count(),
        crlf_before,
        "the fixture must be entirely in CRLF, failing which the scenario measures nothing"
    );

    // WHEN the product merges its fragment into it.
    let merged = merge::<Jsonc>(SETTINGS_CRLF, &fragment()).expect("the merge must succeed");

    // THEN every line ending of the rendered document is CRLF.
    assert_eq!(
        merged.rendered.matches('\n').count(),
        merged.rendered.matches("\r\n").count(),
        "a line ending of the rendered document is no longer CRLF: {:?}",
        merged.rendered
    );
    assert!(
        merged.rendered.matches("\r\n").count() > crlf_before,
        "the posed fragment did not bring its own line ending"
    );

    // AND the byte count of the document did not shrink outside what the trace
    // adds.
    let (disappeared, _) = gap(SETTINGS_CRLF, &merged.rendered);
    assert_eq!(
        disappeared, "",
        "bytes outside the trace disappeared from a CRLF document"
    );
    assert_eq!(
        Jsonc::invert(&merged.rendered, &merged.inverse).expect("the inverse must apply"),
        SETTINGS_CRLF
    );
}

/// A document of two hundred lines, each carrying a key and its value.
fn document_of_two_hundred_lines() -> String {
    let mut document = String::from("{\n");
    for rank in 0..200 {
        document.push_str(&format!("\t\"key{rank:03}\": \"value{rank:03}\",\n"));
    }
    document.push_str("\t\"end\": true\n}\n");
    document
}

#[test]
fn c1_the_document_is_not_re_emitted_whole() {
    // GIVEN an owned document of two hundred lines in which the product modifies
    // one key.
    let before = document_of_two_hundred_lines();
    // The modified key lives at the root; the empty path designates it.
    let edit = Edit::keys(&[], [("key100", Value::text("replaced value"))]);

    // WHEN the pose runs.
    let merged = merge::<Jsonc>(&before, &edit).expect("the merge must succeed");

    // THEN what changes in the file is confined to the neighbourhood of that key.
    let (disappeared, appeared) = gap(&before, &merged.rendered);
    assert!(
        !disappeared.contains('\n') && !appeared.contains('\n'),
        "the change spills past the line of the modified key: {disappeared:?} → {appeared:?}"
    );
    assert!(
        disappeared.len() < 32 && appeared.len() < 32,
        "the change is not confined to the neighbourhood of the key: {disappeared:?} → {appeared:?}"
    );

    // And it does bear on the line of that key: the 199 other value lines are
    // rendered as they were.
    let changed_lines = before
        .lines()
        .zip(merged.rendered.lines())
        .filter(|(a, b)| a != b)
        .count();
    assert_eq!(
        changed_lines, 1,
        "{changed_lines} lines changed for one single modified key"
    );
    assert!(
        merged.rendered.contains("\"key100\": \"replaced value\""),
        "the modified key does not carry its new value"
    );

    // AND the inverse restores the value from before, byte for byte.
    assert_eq!(
        Jsonc::invert(&merged.rendered, &merged.inverse).expect("the inverse must apply"),
        before
    );
}

/// The four layouts of the same document. They are the **same document** to a
/// grammar and **four different documents** to a line-based split: writing all of
/// them is what tells a structural implementation apart from one that looks like
/// it works.
///
/// What "the insertion point" means here: the place where the posed value lands
/// in the array. The markers that will bound a posed block do not exist yet —
/// their syntax and their four wrappings are slice T3c — so the observations of
/// C2 that bear on them are not realised here, and that is written down rather
/// than passed over in silence.
const LAYOUTS: [(&str, &str); 4] = [
    (
        "pre-existing value before the insertion point, on the same line",
        concat!(
            "{\n",
            "  \"instructions\": [\"AGENTS.md\", \"docs/rules.md\"],\n",
            "  \"model\": \"acme/model-small\"\n",
            "}\n",
        ),
    ),
    (
        "pre-existing value after the insertion point, on the same line",
        concat!(
            "{\n",
            "  \"instructions\": [\"docs/rules.md\"], \"model\": \"acme/model-small\"\n",
            "}\n",
        ),
    ),
    (
        "end-of-line comment glued to the array",
        concat!(
            "{\n",
            "  \"instructions\": [\"AGENTS.md\", \"docs/rules.md\"], // keep\n",
            "  \"model\": \"acme/model-small\"\n",
            "}\n",
        ),
    ),
    (
        "whole array on one line, with no space",
        "{\"instructions\":[\"AGENTS.md\",\"docs/rules.md\"],\"model\":\"acme/model-small\"}\n",
    ),
];

#[test]
fn c2_the_four_layouts_are_the_same_document() {
    // GIVEN each of the four layouts, and an entry whose fragment declares that
    // it poses a value into the `instructions` array.
    let edit = Edit::values(&["instructions"], ["docs/pose.md"]);

    for (layout, before) in LAYOUTS {
        // WHEN the pose runs.
        let merged = merge::<Jsonc>(before, &edit)
            .unwrap_or_else(|err| panic!("{layout}: the merge failed — {err}"));

        // THEN the pre-existing value is still a **value** of the array, not a
        // comment — and no pre-existing value was turned into a comment.
        let after = values(&merged.rendered);
        for value in values(before) {
            assert!(
                after.contains(&value),
                "{layout}: the value {value} is no longer a value of the rendered document"
            );
        }
        assert!(
            after.contains(&"instructions = \"docs/pose.md\"".to_string()),
            "{layout}: the posed value is not in the array — {after:?}"
        );

        // AND nothing of the document from before disappeared: what changes
        // reduces to what the trace adds.
        let (disappeared, appeared) = gap(before, &merged.rendered);
        assert_eq!(
            disappeared, "",
            "{layout}: bytes outside the trace disappeared"
        );
        assert!(
            appeared.contains("docs/pose.md"),
            "{layout}: what appeared is not the posed value — {appeared:?}"
        );

        // AND the inverse returns the document from before, byte for byte: that
        // is what makes a removal an effective removal rather than a "leave it
        // in place".
        assert_eq!(
            Jsonc::invert(&merged.rendered, &merged.inverse)
                .unwrap_or_else(|err| panic!("{layout}: the inverse failed — {err}")),
            before,
            "{layout}: the inverse does not return the document from before"
        );
    }
}

#[test]
fn c2_an_end_of_line_comment_glued_to_the_array_keeps_its_place() {
    // GIVEN the same document, with `// keep` at the end of the line, glued to
    // the array.
    let (_, before) = LAYOUTS[2];
    assert!(before.contains("], // keep"));

    // WHEN the pose runs.
    let merged = merge::<Jsonc>(before, &Edit::values(&["instructions"], ["docs/pose.md"]))
        .expect("the merge must succeed");

    // THEN `// keep` is still present, in the same relative place — glued to the
    // closing of the array, and not absorbed into the passage the product claims
    // for itself.
    assert!(
        merged.rendered.contains("], // keep"),
        "the comment changed relative place: {}",
        merged.rendered
    );
    assert!(
        merged.rendered.contains("\"docs/pose.md\"], // keep"),
        "the posed value did not go in before the closing of the array: {}",
        merged.rendered
    );
}

/// C6's own fixture: a `deny` rule the product poses among rules the user
/// wrote by hand. A string carries no place to log an identity, so the rule
/// the pose adds must be found again by the text it carries, never by where
/// it landed.
const DENY_RULES: &str = concat!(
    "{\n",
    "  \"permissions\": {\n",
    "    \"deny\": [\"Bash(curl *)\", \"Read(./secrets/**)\"]\n",
    "  }\n",
    "}\n",
);

#[test]
fn c6_removal_finds_the_posed_value_by_equality_and_leaves_the_users_values_intact() {
    // GIVEN a `deny` rule posed among two rules the user wrote themselves.
    let merged = merge::<Jsonc>(
        DENY_RULES,
        &Edit::values(&["permissions", "deny"], ["Bash(rm -rf *)"]),
    )
    .expect("the pose must succeed");
    assert!(
        values(&merged.rendered).contains(&"permissions.deny = \"Bash(rm -rf *)\"".to_string()),
        "the posed rule is absent from the rendering: {:?}",
        values(&merged.rendered)
    );

    // WHEN the removal runs, by replaying the trace the pose recorded.
    let removed =
        Jsonc::invert(&merged.rendered, &merged.inverse).expect("the removal must succeed");

    // THEN the posed rule is gone, and the two rules the user wrote are intact.
    let after = values(&removed);
    assert!(
        !after.contains(&"permissions.deny = \"Bash(rm -rf *)\"".to_string()),
        "the posed rule survived the removal: {after:?}"
    );
    assert!(after.contains(&"permissions.deny = \"Bash(curl *)\"".to_string()));
    assert!(after.contains(&"permissions.deny = \"Read(./secrets/**)\"".to_string()));
}

#[test]
fn c6_removal_survives_the_user_reordering_the_array() {
    // GIVEN the same pose, on the same document.
    let merged = merge::<Jsonc>(
        DENY_RULES,
        &Edit::values(&["permissions", "deny"], ["Bash(rm -rf *)"]),
    )
    .expect("the pose must succeed");

    // AND the user has since reordered the array by hand: the posed rule
    // moves from last to first. An index does not survive this any better
    // than a line number survives a reformat — the same motive C6 states for
    // banning positional addressing, applied to this one axis.
    const REORDERED: &str = concat!(
        "{\n",
        "  \"permissions\": {\n",
        "    \"deny\": [\"Bash(rm -rf *)\", \"Read(./secrets/**)\", \"Bash(curl *)\"]\n",
        "  }\n",
        "}\n",
    );
    assert_ne!(
        merged.rendered, REORDERED,
        "the reordered fixture must differ from what the pose rendered, or reordering measures \
         nothing"
    );

    // WHEN the removal runs on the reordered document, with the trace the
    // original pose recorded.
    let removed = Jsonc::invert(REORDERED, &merged.inverse).expect("the removal must succeed");

    // THEN the posed rule is still found and removed, and the user's rules are
    // intact wherever they now sit.
    let after = values(&removed);
    assert!(
        !after.contains(&"permissions.deny = \"Bash(rm -rf *)\"".to_string()),
        "the posed rule survived the removal: {after:?}"
    );
    assert!(after.contains(&"permissions.deny = \"Bash(curl *)\"".to_string()));
    assert!(after.contains(&"permissions.deny = \"Read(./secrets/**)\"".to_string()));
}

#[test]
fn c6_a_value_already_present_does_not_enter_the_trace() {
    // GIVEN an entry whose fragment declares that it poses `AGENTS.md`, which is
    // already the first value of the array.
    let (_, before) = LAYOUTS[0];

    // WHEN the pose runs.
    let merged = merge::<Jsonc>(before, &Edit::values(&["instructions"], ["AGENTS.md"]))
        .expect("the merge must succeed");

    // THEN the document does not move, and the trace records nothing: the product
    // removes only what it added itself, and a value it did not add must not
    // leave the document on removal.
    assert_eq!(merged.rendered, before);
    assert!(
        merged.inverse.is_empty(),
        "the trace claims a value the product did not add: {:?}",
        merged.inverse
    );
}

/// The replacements whose pre-image is **not** made of values alone: the bytes
/// composing it also carry a comment, or an escape the document chose.
///
/// What the trace records of a replaced key is its **semantic** value, and a
/// semantic value carries neither comment nor escape. Restoring those pre-images
/// would therefore return a document the owner did not write — and the semantic
/// post-condition does not see it, since it compares leaves only.
fn replacements_whose_preimage_is_not_restored() -> Vec<(&'static str, &'static str, Edit)> {
    vec![
        (
            "a comment inside the replaced object",
            concat!(
                "{\n",
                "\t\"permissions\": {\n",
                "\t\t// my rules, do not touch\n",
                "\t\t\"deny\": [\"Bash(rm -rf *)\"] // important\n",
                "\t},\n",
                "\t\"model\": \"acme/model-small\"\n",
                "}\n",
            ),
            Edit::keys(
                &[],
                [(
                    "permissions",
                    Value::Object(vec![(
                        "deny".to_string(),
                        Value::List(vec![Value::text("Bash(true)")]),
                    )]),
                )],
            ),
        ),
        (
            "a comment inside the replaced array",
            concat!("{\n", "\t\"users\": [\"u1\", /* keep */ \"u2\"]\n", "}\n"),
            Edit::keys(
                &[],
                [(
                    "users",
                    Value::List(vec![Value::text("u1"), Value::text("u2")]),
                )],
            ),
        ),
        (
            "an escape inside the replaced string",
            concat!("{\n", "  \"a\": \"caf\\u00e9\",\n", "  \"b\": 1\n", "}\n",),
            Edit::keys(&[], [("a", Value::text("x"))]),
        ),
    ]
}

#[test]
fn c1_a_replacement_whose_preimage_is_not_restored_aborts() {
    for (case, before, edit) in replacements_whose_preimage_is_not_restored() {
        // GIVEN an owned document whose replaced key carries bytes the trace does
        // not record.
        // WHEN a pose goes through the grammar.
        let failure = merge::<Jsonc>(before, &edit).err().unwrap_or_else(|| {
            panic!("{case}: the merge succeeded on a write it does not know how to undo")
        });

        // THEN the transaction aborts, and the message names the grammar and what
        // was not preserved.
        let message = failure.to_string();
        for expected in ["jsonc", "does not undo"] {
            assert!(
                message.contains(expected),
                "{case}: the refusal does not name \"{expected}\" — {message}"
            );
        }
    }
}

/// Guard, not scenario: the refusal above must hold because the pre-image is not
/// restorable, and **never** because of a replacement in itself. Without this
/// guard, refusing every replacement would turn the scenario green by removing
/// the very capability it frames.
#[test]
fn guard_a_replacement_whose_preimage_is_restored_stays_possible() {
    const BEFORE: &str = concat!(
        "{\n",
        "\t\"permissions\": {\n",
        "\t\t\"deny\": [\"Bash(rm -rf *)\"]\n",
        "\t}, // keep\n",
        "\t\"model\": \"acme/model-small\"\n",
        "}\n",
    );
    let edit = Edit::keys(
        &[],
        [(
            "permissions",
            Value::Object(vec![(
                "deny".to_string(),
                Value::List(vec![Value::text("Bash(true)")]),
            )]),
        )],
    );

    let merged = merge::<Jsonc>(BEFORE, &edit).expect("the merge must succeed");
    assert!(merged.rendered.contains("Bash(true)"));
    assert!(
        merged.rendered.contains("// keep"),
        "the comment outside the replaced value disappeared: {}",
        merged.rendered
    );
    assert_eq!(
        Jsonc::invert(&merged.rendered, &merged.inverse).expect("the inverse must apply"),
        BEFORE
    );
}

/// Guard, not scenario: the duplicate key is admitted by the format, which leaves
/// undefined what a reader makes of it. The **read** path has refused it since
/// T3a; the **write** path must refuse it too, failing which it would write into
/// an occurrence that nothing says is the one that counts — ineffective with no
/// error and no trace.
#[test]
fn guard_the_write_path_refuses_a_duplicated_key() {
    const DUPLICATE_KEY: &str = concat!(
        "{\n",
        "  \"instructions\": [\"docs/a.md\"],\n",
        "  \"instructions\": [\"docs/b.md\"]\n",
        "}\n",
    );

    let failure = merge::<Jsonc>(
        DUPLICATE_KEY,
        &Edit::values(&["instructions"], ["docs/pose.md"]),
    )
    .expect_err("the write arbitrated between two definitions of the same key");

    let message = failure.to_string();
    for expected in ["jsonc", "instructions"] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }
}

/// Guard, not scenario: a path that does not exist is refused by being named,
/// rather than by fabricating the missing structure. The product writes only
/// where it was confirmed that it would write.
#[test]
fn guard_an_absent_path_is_refused_by_being_named() {
    let failure = merge::<Jsonc>(SETTINGS, &Edit::values(&["absent", "deny"], ["x"]))
        .expect_err("an absent path must be refused");
    let message = failure.to_string();
    assert!(
        message.contains("absent"),
        "the refusal does not name the path: {message}"
    );
    assert!(
        matches!(failure, MergeError::Grammar(_)),
        "the refusal must come from the grammar: {failure:?}"
    );
}
