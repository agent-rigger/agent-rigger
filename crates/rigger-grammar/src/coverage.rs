//! Renders the coverage page — `docs/coverage.md` — from a measured
//! [`Capabilities`] table.
//!
//! **Why this lives in production and not in the golden test.** H1's mandate
//! forbade any line of production code, and `table()` had no production
//! caller yet, so the only thing able to run this rendering was a test:
//! `crates/rigger-grammar/tests/coverage.rs` carried it. `crates/rigger-cli`
//! is now that caller — a binary in another crate cannot call the test code
//! of this one — so the rendering moved here, `pub`, and the golden test
//! became its **caller** instead of its owner.
//!
//! **Moved, not rewritten.** Recomputing the same page a second way here
//! would let two copies of the same rule drift apart while agreeing by
//! accident; the golden comparison in `tests/coverage.rs` is what proves this
//! move was faithful — it stays byte for byte identical to what the page was
//! before the move.

use crate::marker::Wrapping;
use crate::{Capabilities, GrammarRole, MergeAdmission, Resolution};

/// Renders the coverage page from a measured table, plus limits that name
/// something the product does not do or does not observe, no grammar's
/// capability table involved.
///
/// The matrix and "Declared limits" come only from the public accessors of
/// [`Capabilities`] and [`crate::SHARED_CORPUS`] — nothing there is declared
/// by hand about a grammar. Writing a value there that `table()` did not
/// produce would be exactly the failure MD-39·5 exists to close. `host_limits`
/// is different by construction: each entry is a line this function trusts
/// its caller to have already stated correctly, because nothing in this
/// crate — pure, and blind to any host — could measure it itself.
pub fn render(table: &[Capabilities], host_limits: &[&str]) -> String {
    let mut page = String::new();
    page.push_str("# Coverage\n\n");
    page.push_str(
        "This page is rendered by `rigger-cli`, and it is never edited by hand. The matrix and \
         \"Declared limits\" come from `rigger_grammar::table()`, checked byte for byte against \
         everything above \"What the product cannot observe\" by \
         `crates/rigger-grammar/tests/coverage.rs`; that section is not derived from any \
         grammar's table, so the whole page — it included — is instead checked by \
         `crates/rigger-cli/tests/coverage_command.rs`, which runs the compiled binary and \
         compares its stdout to this file. A cell reading \"never\" in the matrix names a limit \
         the derivation measured, not one this page assumes; where the derivation also names why, \
         the reason is under \"Declared limits\" below.\n\n",
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
    if !host_limits.is_empty() {
        page.push('\n');
        page.push_str("## What the product cannot observe\n\n");
        page.push_str(
            "None of the lines below come from a grammar's capability table, and none is lifted \
             by a grammar changing. Each names something the product itself never does or never \
             asks a host — never a claim about what any host does on its own.\n\n",
        );
        page.push_str(&render_host_limits(host_limits));
    }
    page
}

/// The matrix itself: one row per grammar `table()` published, one column per
/// public property of [`Capabilities`].
pub fn render_matrix(table: &[Capabilities]) -> String {
    let total_corpus = crate::SHARED_CORPUS.len();
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
/// [`crate::MergeRefusal`]'s own [`std::fmt::Display`] rather than composing a
/// second wording that could drift from it.
pub fn render_declared_limits(table: &[Capabilities]) -> String {
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

pub fn render_role(role: GrammarRole) -> &'static str {
    match role {
        GrammarRole::ReadOnly => "read-only",
        GrammarRole::ReadWrite => "read-write",
    }
}

pub fn render_resolution(resolution: Resolution) -> &'static str {
    match resolution {
        Resolution::DependsOnOrder => "depends on order",
        Resolution::IndependentOfOrder => "independent of order",
    }
}

pub fn render_bool(value: bool) -> &'static str {
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

/// The lines a caller supplies because this crate — pure, and blind to any
/// host — cannot measure them itself. Same bullet form as
/// [`render_declared_limits`], on purpose: a reader should not have to learn
/// a second layout to read a second kind of limit.
fn render_host_limits(limits: &[&str]) -> String {
    let mut out = String::new();
    for limit in limits {
        out.push_str(&format!("- {limit}\n"));
    }
    out
}

fn wrapping_name(wrapping: Wrapping) -> &'static str {
    match wrapping {
        Wrapping::LineComment => "line comment",
        Wrapping::BlockCommentInline => "inline block comment",
        Wrapping::BlockCommentSpanning => "spanning block comment",
        Wrapping::Bare => "bare",
    }
}
