//! The golden test of MD-39·5: `docs/coverage.md` is rendered from
//! `rigger_grammar::table()`, never written by hand, and compared to the
//! committed file byte for byte.
//!
//! **What this closes, and what it does not.** `table()` is exercised end to
//! end by `capabilities.rs` and `conformance.rs` — this file adds the one
//! property neither of them checks: that the page an adopter actually reads
//! says exactly what the derivation measured, in the form
//! `03-surface-publique.md` § 3 fixes for `coverage.md` — a matrix produced
//! from the code, where a cell may read "never", and the reason is named where
//! the derivation names one. It does not judge whether the derivation itself
//! is correct; that is the job of the tests it draws on.
//!
//! **Why the rendering lives here and not in `docs/coverage.md`.** The page
//! has no way to write itself, and `table()` has no production caller yet —
//! see `capability.rs`. Until one exists, a test is the only thing that can
//! run the derivation, so a test is what renders the page.
//!
//! **Regenerating the golden.** Never hand-edit `docs/coverage.md`. When
//! `table()` changes on purpose, run:
//!
//! ```text
//! RIGGER_UPDATE_COVERAGE_GOLDEN=1 cargo test -p rigger-grammar --test coverage
//! ```
//!
//! which overwrites the golden with the freshly rendered page instead of
//! comparing against it, then run the test again without the variable to
//! confirm it is green. Regenerating is a decision, not a formality: the
//! change that does it should say what moved in `table()` to justify the new
//! page — a silently rewritten golden compares the code to itself and stops
//! measuring anything.

use std::env;
use std::path::PathBuf;

use rigger_grammar::marker::Wrapping;
use rigger_grammar::{Capabilities, GrammarRole, MergeAdmission, Resolution};

#[test]
fn md39_5_coverage_page_matches_the_capability_table() {
    let table = rigger_grammar::table();
    let rendered = render(&table);
    let golden_path = golden_path();

    if env::var_os("RIGGER_UPDATE_COVERAGE_GOLDEN").is_some() {
        std::fs::write(&golden_path, &rendered).unwrap_or_else(|err| {
            panic!(
                "cannot write the regenerated golden at {}: {err}",
                golden_path.display()
            )
        });
        return;
    }

    let golden = std::fs::read_to_string(&golden_path).unwrap_or_else(|err| {
        panic!(
            "cannot read the golden at {} — has it been generated at all? {err}",
            golden_path.display()
        )
    });

    assert_eq!(
        rendered, golden,
        "docs/coverage.md no longer matches the page rendered from `table()`. If this \
         divergence is expected, regenerate with `RIGGER_UPDATE_COVERAGE_GOLDEN=1 cargo test \
         -p rigger-grammar --test coverage` and say, in the change that does it, what moved in \
         `table()` to justify the new page — never rewrite the golden to make this test pass \
         without knowing why it was red"
    );
}

/// `agent-rigger/docs/coverage.md`, reached from this crate's manifest
/// directory so the test does not depend on the working directory it runs
/// from.
fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("coverage.md")
}

/// Renders the coverage page from a measured table.
///
/// The only inputs are the public accessors of [`Capabilities`] and
/// [`rigger_grammar::SHARED_CORPUS`] — nothing here is declared by hand about
/// a grammar. Writing a value here that `table()` did not produce would be
/// exactly the failure MD-39·5 exists to close, moved one file to the left.
fn render(table: &[Capabilities]) -> String {
    let mut page = String::new();
    page.push_str("# Coverage\n\n");
    page.push_str(
        "This page is rendered from `rigger_grammar::table()` and checked byte for byte by \
         `crates/rigger-grammar/tests/coverage.rs` — it is never edited by hand. A cell reading \
         \"never\" names a limit the derivation measured, not one this page assumes; where the \
         derivation also names why, the reason is under \"Declared limits\" below.\n\n",
    );
    page.push_str("## What each grammar can express\n\n");
    page.push_str(&render_matrix(table));
    page.push('\n');
    page.push_str("## Declared limits\n\n");
    page.push_str(
        "Each entry below is a refusal the derivation named, with every reason it observed, in \
         the order it observed them. Lifting one requires the grammar to change; it is never \
         lifted by editing this page.\n\n",
    );
    page.push_str(&render_declared_limits(table));
    page
}

/// The matrix itself: one row per grammar `table()` published, one column per
/// public property of [`Capabilities`].
fn render_matrix(table: &[Capabilities]) -> String {
    let total_corpus = rigger_grammar::SHARED_CORPUS.len();
    let mut out = String::new();
    out.push_str(
        "| Grammar | Role | Preserves trivia | Corpus documents read | Designates a list \
         element | Applies and undoes an edit | Resolution | Carries a bounded block | \
         `merge`, these keys at this path | `merge`, this block between these bounds |\n",
    );
    out.push_str("|---|---|---|---|---|---|---|---|---|---|\n");
    for capabilities in table {
        let grammar = capabilities.grammar();
        let role = render_role(capabilities.role());
        let preserves_trivia = render_bool(capabilities.preserves_trivia());
        let corpus_read = capabilities.shared_corpus_documents_read();
        let designates_list_element = render_bool(capabilities.designates_list_element());
        let applies_edits = render_bool(capabilities.applies_edits());
        let resolution = render_resolution(capabilities.resolution());
        let bounded_block = render_wrappings(capabilities.delimiter_wrappings());
        let merge_by_keys = render_admission(capabilities.merge_by_keys());
        let merge_bounded_block = render_admission(capabilities.merge_bounded_block());
        out.push_str(&format!(
            "| `{grammar}` | {role} | {preserves_trivia} | {corpus_read} of {total_corpus} | \
             {designates_list_element} | {applies_edits} | {resolution} | {bounded_block} | \
             {merge_by_keys} | {merge_bounded_block} |\n"
        ));
    }
    out
}

/// The reasons behind every `never` in the two `merge` columns, reusing
/// [`rigger_grammar::MergeRefusal`]'s own [`std::fmt::Display`] rather than
/// composing a second wording that could drift from it.
fn render_declared_limits(table: &[Capabilities]) -> String {
    let mut out = String::new();
    for capabilities in table {
        for admission in [
            capabilities.merge_by_keys(),
            capabilities.merge_bounded_block(),
        ] {
            if let MergeAdmission::Refused(refusal) = admission {
                out.push_str(&format!("- {refusal}\n"));
            }
        }
    }
    if out.is_empty() {
        out.push_str("No form of `merge` is refused on a published grammar today.\n");
    }
    out
}

fn render_role(role: GrammarRole) -> &'static str {
    match role {
        GrammarRole::ReadOnly => "read-only",
        GrammarRole::ReadWrite => "read-write",
    }
}

fn render_resolution(resolution: Resolution) -> &'static str {
    match resolution {
        Resolution::DependsOnOrder => "depends on order",
        Resolution::IndependentOfOrder => "independent of order",
    }
}

fn render_bool(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "never"
    }
}

fn render_admission(admission: &MergeAdmission) -> &'static str {
    match admission {
        MergeAdmission::Admitted => "admitted",
        MergeAdmission::Refused(_) => "never",
    }
}

/// The wrappings under which every document the grammar reads can carry a
/// bounded block, in the order [`Wrapping::ALL`] declares them — the same
/// order [`Capabilities::delimiter_wrappings`] preserves, so this reads them
/// rather than re-deriving an order of its own.
fn render_wrappings(wrappings: &[Wrapping]) -> String {
    if wrappings.is_empty() {
        return "never".to_string();
    }
    wrappings
        .iter()
        .map(|&wrapping| wrapping_name(wrapping))
        .collect::<Vec<_>>()
        .join(", ")
}

fn wrapping_name(wrapping: Wrapping) -> &'static str {
    match wrapping {
        Wrapping::LineComment => "line comment",
        Wrapping::BlockCommentInline => "inline block comment",
        Wrapping::BlockCommentSpanning => "spanning block comment",
        Wrapping::Bare => "bare",
    }
}
