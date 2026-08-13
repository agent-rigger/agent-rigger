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

use rigger_grammar::marker::{
    place, read, remove, BlockTrace, Classification, Marker, Pose, Wrapping,
};
use rigger_grammar::{
    merge, unmerge, Applied, Edit, Grammar, GrammarError, GrammarRole, Inverse, Jsonc, MergeError,
    Probe, Resolution, SemanticValue, Value,
};

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
/// What "the insertion point" means depends on which shape of trace is being
/// written. For a value posed into the array it is the place that value lands
/// in. For a **bounded block** it is the place the block is written, and the
/// three observations C2 makes about the delimiters of such a block — the
/// opening delimiter shares no line with a value that is not its own, the
/// reading back yields one single passage, the later removal is an effective
/// removal — are realised on these same four documents by the three
/// `c2_…marker…` tests below.
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

/// The provenance of the catalogue publishing the entry the three tests below
/// pose, and that entry's own identifier. A marker carries both, in clear.
const CATALOGUE: &str = "github.com/acme/rig";
const ENTRY: &str = "context/agents";

/// The address the trace records for the document those three write in. It is
/// what a refusal names alongside a value, and it is never a line number.
const ADDRESS: &str = "settings.json";

/// The line a catalogue publishes and a pose writes between its bounds.
const POSED_BODY: &[&str] = &["a line a catalogue would pose"];

fn marker() -> Marker {
    Marker::new(CATALOGUE, ENTRY)
}

/// The four layouts, as documents a block is posed at the **end** of: each one
/// is the layout stripped of its final line terminator.
///
/// **Why stripped, and why that is not a contrivance.** A pose writes its
/// opening delimiter at the end of the document, so the question C2 asks — does
/// that delimiter share a line with a value that is not its own — only has an
/// answer where the last line carries a value and no terminator. Leave the
/// terminator on and no writer could glue anything onto that line even by
/// accident, and the clause would measure nothing. A file whose last line
/// carries no terminator is what an editor that does not add one produces, which
/// is most of them.
fn documents_ending_on_a_value() -> Vec<(&'static str, String)> {
    LAYOUTS
        .iter()
        .map(|(layout, source)| {
            let document = source.trim_end_matches('\n').to_string();
            assert!(
                !document.is_empty() && !document.ends_with('\n'),
                "{layout}: the last line must carry a value and no terminator, or the clause on \
                 the opening delimiter measures nothing"
            );
            (*layout, document)
        })
        .collect()
}

/// The pose those three tests run, in the wrapping the archived defect happened
/// under: a line comment, which is what turned a value of the owner into a
/// comment the day it was written onto that value's line.
///
/// Whether a JSON settings document is **able** to carry a bounded block is a
/// different question, answered by the capability table — by running this same
/// function and reading the rendering back with the grammar — and answered `no`.
/// What is measured here is the writer: it splits nothing into lines to decide
/// where to write, and the four layouts are four line dispositions of one
/// document, which is exactly where a writer that did would come apart.
fn pose<'a>(
    marker: &'a Marker,
    traced: &'a [Marker],
    posed: Option<&'a BlockTrace>,
    body: &'a [&'a str],
) -> Pose<'a> {
    Pose {
        marker,
        address: ADDRESS,
        roots: &["/home/u/.config/rig"],
        traced,
        posed,
        body,
        wrapping: Wrapping::LineComment,
    }
}

/// The one line of `rendered` carrying `token`, and the demand that there be
/// exactly one: a token on two lines is a block nothing can tell from another.
fn sole_line_carrying<'a>(rendered: &'a str, token: &str, layout: &str) -> &'a str {
    let mut carrying = rendered.lines().filter(|line| line.contains(token));
    let line = carrying
        .next()
        .unwrap_or_else(|| panic!("{layout}: no line of the rendering carries `{token}`"));
    assert!(
        carrying.next().is_none(),
        "{layout}: `{token}` sits on more than one line of the rendering"
    );
    line
}

/// C2 on the delimiters of a posed block: **the opening delimiter shares no
/// line with a value that is not its own.**
///
/// This is the clause the archived implementation broke, and the damage it did
/// is the reason C2 exists: the opening delimiter was written onto a line that
/// already carried the owner's values, and everything following it on that line
/// left the document as a comment. In an array of instruction paths, that is a
/// path the owner had asked for and no longer gets.
///
/// What keeps it from happening is the write itself — a pose puts its block on
/// lines of its own — and, behind it, the post-condition `place` runs on its own
/// rendering: a delimiter glued to somebody else's text is a delimiter the
/// recogniser cannot read back, and a block the recogniser cannot find delimits
/// nothing, so the pose refuses rather than leave one.
#[test]
fn c2_the_opening_marker_shares_no_line_with_a_value_that_is_not_its_own() {
    let marker = marker();

    for (layout, before) in documents_ending_on_a_value() {
        // GIVEN one of the four layouts, whose last line carries the owner's
        // values, and an entry posed as a bounded block.
        // WHEN the pose runs.
        let placed = place(&before, &pose(&marker, &[], None, POSED_BODY)).unwrap_or_else(|err| {
            panic!("{layout}: the block was not posed on lines of its own — {err}")
        });

        // THEN the opening delimiter is alone on its line — and so is the
        // closing one, which owes the same and for the same reason.
        for token in [marker.open(), marker.close()] {
            assert_eq!(
                sole_line_carrying(&placed.rendered, &token, layout).trim(),
                format!("// {token}"),
                "{layout}: the delimiter shares its line with text the product did not write"
            );
        }

        // AND no value the owner wrote was passed into a comment: every line of
        // the document from before is still a whole line of the rendering.
        for line in before.lines() {
            assert!(
                placed.rendered.lines().any(|rendered| rendered == line),
                "{layout}: {line:?} is no longer a line of the document"
            );
        }
    }
}

/// C2 on the delimiters of a posed block: **reading it back yields one single
/// passage, never an ambiguous one.**
///
/// The pose that decides this is the **second** one. A first pose writes a block
/// where there was none; an update has to rewrite the bounds of the block it
/// already owns, and a writer that appends instead leaves two passages under one
/// marker. Nothing then says which of the two the product wrote, so it can
/// remove neither: the entry becomes permanently unremovable, and every further
/// pose adds another copy.
#[test]
fn c2_the_marker_reads_back_as_one_passage_and_never_as_an_ambiguous_one() {
    let marker = marker();
    let traced = [marker.clone()];
    const UPDATED_BODY: &[&str] = &["a line a catalogue would pose", "and one the update adds"];

    for (layout, before) in documents_ending_on_a_value() {
        // GIVEN one of the four layouts, and a block posed into it.
        let placed = place(&before, &pose(&marker, &[], None, POSED_BODY))
            .unwrap_or_else(|err| panic!("{layout}: the first pose failed — {err}"));
        assert_eq!(
            read(&placed.rendered, ADDRESS, &marker)
                .recognition
                .classification(),
            Classification::Unique,
            "{layout}: what the pose just wrote does not read back as one single passage"
        );

        // WHEN the same entry is posed again — an update, carrying the trace of
        // what the product wrote here the first time.
        let updated = place(
            &placed.rendered,
            &pose(&marker, &traced, Some(&placed.trace), UPDATED_BODY),
        )
        .unwrap_or_else(|err| panic!("{layout}: the update failed — {err}"));

        // THEN the rendering still carries one single passage, and the update
        // did land.
        assert_eq!(
            read(&updated.rendered, ADDRESS, &marker)
                .recognition
                .classification(),
            Classification::Unique,
            "{layout}: the update left a passage nothing can tell apart from another"
        );
        assert!(
            updated.rendered.contains("and one the update adds"),
            "{layout}: the update rewrote nothing, so the check above measures a pose that did \
             not happen"
        );
    }
}

/// C2 on the delimiters of a posed block: **the later removal is an effective
/// removal, never a "leave it in place".**
///
/// A write that gives back the document it was handed destroys nothing and
/// disturbs no neighbour, so no comparison of values can see anything wrong with
/// it. Reported as a removal, it leaves a machine that believes itself clean:
/// the entry is gone from the registry and the block is still in the file, where
/// no trace will ever name it again.
///
/// **Why this one does not compare the bytes, where the other removals do.** On
/// a document whose last line carried no terminator, the pose had to write one
/// so that its opening delimiter would not land on that line — the clause above.
/// The trace records the body it wrote and not that terminator, so the removal
/// gives back the document from before plus one line ending. That is a byte
/// added and never a value lost, which is why no post-condition sees it; and
/// closing it means recording the terminator in the trace, which is a change to
/// what a trace carries and not an observation about markers. It is stated here
/// rather than asserted, so that a reader comparing this test with the removals
/// that do check the bytes finds the reason instead of a silence.
#[test]
fn c2_the_marker_is_removed_effectively_and_never_left_in_place() {
    let marker = marker();

    for (layout, before) in documents_ending_on_a_value() {
        // GIVEN one of the four layouts, and a block posed into it.
        let placed = place(&before, &pose(&marker, &[], None, POSED_BODY))
            .unwrap_or_else(|err| panic!("{layout}: the pose failed — {err}"));

        // WHEN the removal runs, by replaying the trace the pose recorded.
        let removed = remove(&placed.rendered, &placed.trace)
            .unwrap_or_else(|err| panic!("{layout}: the removal did not happen — {err}"));

        // THEN nothing of the block is left: no delimiter, no body line, and the
        // recogniser finds no passage.
        assert_eq!(
            read(&removed.rendered, ADDRESS, &marker)
                .recognition
                .classification(),
            Classification::Absent,
            "{layout}: the removal left the passage where it was"
        );
        for token in [marker.open(), marker.close()] {
            assert!(
                !removed.rendered.contains(&token),
                "{layout}: `{token}` survived the removal"
            );
        }
        for body in POSED_BODY {
            assert!(
                !removed.rendered.contains(body),
                "{layout}: the posed line {body:?} survived the removal"
            );
        }

        // AND every line the owner wrote is back, whatever the layout put on it.
        for line in before.lines() {
            assert!(
                removed.rendered.lines().any(|rendered| rendered == line),
                "{layout}: the removal took {line:?} with it"
            );
        }
    }
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

/// D10 — `Jsonc::invert`'s `Values` arm, on its own, without going through
/// `unmerge`. `find_string_element` returning `None` used to fall out of the
/// loop in silence and hand the document back unchanged (`Ok`) instead of
/// refusing — the sibling of the gap D1 closed in `merge::accounted_for`, but
/// on the grammar's own inverse rather than on the accounting run around it.
/// Every caller in this crate hands `invert` a value it just wrote, or a
/// value `accounted_for` has already found — this test is the one place that
/// removes both guards on purpose, so the refusal has to come from `invert`
/// itself.
#[test]
fn guard_invert_refuses_a_value_removal_the_document_no_longer_carries() {
    // GIVEN a document that never carried the value a trace names — stands
    // for an owner who deleted it between the pose and this replay.
    const DOCUMENT: &str = concat!("{\n", "  \"instructions\": [\"AGENTS.md\"]\n", "}\n",);
    let inverse = Inverse::Values {
        path: vec!["instructions".to_string()],
        added: vec!["posed.md".to_string()],
    };
    assert!(
        !DOCUMENT.contains("posed.md"),
        "the fixture must not carry the value, or this test measures nothing"
    );

    // WHEN `invert` replays that trace directly, with no `accounted_for` and
    // no caller-guaranteed presence standing in front of it.
    let refusal = Jsonc::invert(DOCUMENT, &inverse)
        .expect_err("a value the document no longer carries must not be silently skipped");

    // THEN it names the array and the value, rather than handing the document
    // back untouched.
    match &refusal {
        GrammarError::ValueNotFound { path, value, .. } => {
            assert_eq!(path, "instructions");
            assert_eq!(value, "posed.md");
        }
        other => panic!("the refusal does not name what is missing: {other:?}"),
    }
}

/// The third trace shape, on the arm the two guards above left alone.
///
/// `Inverse::Keys` is what a `merge` posing object keys records, and it is the
/// most common shape this grammar produces. Its inversion skipped a key the
/// document no longer carries, exactly as the other two arms did before they
/// were closed — and nothing downstream could catch it: the post-condition
/// compares what **disappeared** between the document before and the rendering
/// after, so a replay that changes nothing leaves it nothing to compare.
///
/// A removal that reports success over a document it never touched is the one
/// outcome this crate exists to prevent.
#[test]
fn guard_invert_refuses_a_key_removal_the_document_no_longer_carries() {
    // GIVEN a document that does not carry the key a trace names — the owner
    // deleted it between the pose and this replay.
    const DOCUMENT: &str = concat!("{\n", "  \"model\": \"opus\"\n", "}\n",);
    let inverse = Inverse::Keys {
        path: Vec::new(),
        added: vec!["statusLine".to_string()],
        replaced: Vec::new(),
    };
    assert!(
        !DOCUMENT.contains("statusLine"),
        "the fixture must not carry the key, or this test measures nothing"
    );

    // WHEN `invert` replays that trace directly, with nothing standing in front
    // of it to guarantee the key is still there.
    let refusal = Jsonc::invert(DOCUMENT, &inverse)
        .expect_err("a key the document no longer carries must not be silently skipped");

    // THEN it names the key, rather than handing the document back untouched.
    match &refusal {
        GrammarError::KeyNotFound { key, .. } => assert_eq!(key, "statusLine"),
        other => panic!("the refusal does not name what is missing: {other:?}"),
    }
}

/// The same arm, on the gesture that does not merely stay silent but **writes**.
///
/// A key the pose replaced is undone by putting its earlier value back, and
/// that inversion is only defined while the document still holds what the pose
/// left there. Once the owner has deleted the key outright, writing the earlier
/// value back does not undo a pose — it creates a key a person removed, with
/// bytes this product never posed.
///
/// It is worse than the silent skip above, and harder to see: the post-condition
/// only ever compares what **disappeared**, so a key that **appears** passes
/// every check this crate makes.
#[test]
fn guard_invert_refuses_to_restore_a_key_the_owner_has_deleted() {
    // GIVEN a document the owner has emptied of the key a trace replaced.
    const DOCUMENT: &str = concat!("{\n", "  \"model\": \"opus\"\n", "}\n",);
    let inverse = Inverse::Keys {
        path: Vec::new(),
        added: Vec::new(),
        replaced: vec![("statusLine".to_string(), Value::text("before the pose"))],
    };
    assert!(
        !DOCUMENT.contains("statusLine"),
        "the fixture must not carry the key, or this test measures nothing"
    );

    // WHEN `invert` replays that trace directly.
    let refusal = Jsonc::invert(DOCUMENT, &inverse)
        .expect_err("restoring a key the owner deleted writes bytes this product never posed");

    // THEN it names the key rather than putting it back.
    match &refusal {
        GrammarError::KeyNotFound { key, .. } => assert_eq!(key, "statusLine"),
        other => panic!("the refusal does not name what is missing: {other:?}"),
    }
}

/// A grammar whose inversion stays silent on a key the document no longer
/// carries, as this one's did before that arm was closed.
///
/// It exists so the guard below measures **the accounting's own lookup** and
/// not the refusal that now sits downstream of it: with the real grammar, the
/// inversion refuses first and the guard would pass whatever the accounting
/// does or does not check.
struct InvertSilentOnMissingKey;

impl Grammar for InvertSilentOnMissingKey {
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

    fn find_key(source: &str, path: &[String], key: &str) -> Result<bool, GrammarError> {
        Jsonc::find_key(source, path, key)
    }

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        Jsonc::apply(source, edit)
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        match Jsonc::invert(source, inverse) {
            Err(GrammarError::KeyNotFound { .. }) => Ok(source.to_string()),
            other => other,
        }
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Jsonc::values(source)
    }

    fn comments(source: &str) -> Result<Vec<String>, GrammarError> {
        Jsonc::comments(source)
    }
}

/// The accounting reads the document for the key shape too, and refuses on its
/// own rather than leaning on the inversion downstream of it.
///
/// **Why the substitute grammar.** The real inversion refuses this case since
/// the arm was closed, so a guard using it would pass no matter what the
/// accounting checks — it would measure the wrong function. The substitute
/// swallows exactly that refusal and nothing else, leaving the accounting's own
/// lookup as the only thing that can still catch the missing key.
#[test]
fn guard_accounted_for_refuses_a_key_the_document_no_longer_carries_when_invert_stays_silent() {
    // GIVEN a trace naming a key the document does not carry.
    const DOCUMENT: &str = concat!("{\n", "  \"model\": \"opus\"\n", "}\n",);
    let inverse = Inverse::Keys {
        path: Vec::new(),
        added: vec!["statusLine".to_string()],
        replaced: Vec::new(),
    };

    // WHEN `unmerge` replays it through a grammar whose inversion stays silent.
    let verdict = unmerge::<InvertSilentOnMissingKey>(DOCUMENT, &inverse);

    // THEN the accounting must refuse by itself, naming the key.
    let refusal =
        verdict.expect_err("the accounting must refuse a key the document no longer carries");
    assert!(
        format!("{refusal}").contains("statusLine"),
        "the refusal does not name the missing key: {refusal:?}"
    );
}
