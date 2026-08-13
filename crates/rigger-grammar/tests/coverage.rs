//! The golden test of MD-39·5: the grammar-derived portion of
//! `docs/coverage.md` — everything from `# Coverage` up to, but excluding,
//! "## What the product cannot observe" — is rendered from
//! `rigger_grammar::table()`, never written by hand, and compared to the
//! committed file byte for byte.
//!
//! **What this closes, and what it does not.** `table()` is exercised end to
//! end by `capabilities.rs` and `conformance.rs` — this file adds the one
//! property neither of them checks: that the page an adopter actually reads
//! says exactly what the derivation measured — a matrix produced from the
//! code, where a cell may read "never", and the reason is named where the
//! derivation names one. It does not judge whether the derivation itself is
//! correct; that is the job of the tests it draws on.
//!
//! **Narrowed scope, declared here rather than left to be discovered.** Until
//! B7, this test compared the whole committed file. `render` now also takes
//! `host_limits` — lines this crate is structurally unable to produce, because
//! it is pure and knows nothing of a host — and this test calls it with none,
//! so what it reconstructs is only the part of the page `table()` actually
//! drives. `crates/rigger-cli/tests/coverage_command.rs` is what covers the
//! full page today, host section included: it runs the compiled binary, which
//! supplies `rigger-apply`'s host limits, and diffs its stdout against this
//! same committed file in full.
//!
//! **Why the rendering is called here and not owned here.** It used to be:
//! `table()` had no production caller, and this test was the only thing that
//! could run the derivation, so H1 wrote the rendering here under its own
//! mandate — no production line. `crates/rigger_grammar::coverage` now owns
//! it, `pub`, because `crates/rigger-cli` calls it too and a binary in
//! another crate cannot reach into this crate's tests. This file is the
//! rendering's appellant, not its owner: it still measures the one thing
//! neither `capability.rs` nor the CLI's own test can — that the committed
//! page's grammar-derived section matches the table byte for byte.
//!
//! **Regenerating the golden.** Never hand-edit `docs/coverage.md`. This test
//! no longer owns the whole file, so — unlike before B7 — it offers no
//! env-var rewrite of it: doing that here would silently truncate the host
//! section this test cannot see. Regenerate the whole committed page by
//! running the binary that composes both halves and overwriting the file
//! with its output:
//!
//! ```text
//! cargo run -p rigger-cli -- coverage > docs/coverage.md
//! ```
//!
//! then run both this test and `coverage_command.rs` to confirm the two
//! halves — grammar-derived and host-derived — still agree with what was
//! committed. Regenerating is a decision, not a formality: the change that
//! does it should say what moved in `table()`, or in `rigger-apply`'s
//! constants, to justify the new page.

use std::path::PathBuf;

use rigger_grammar::coverage::render;

/// The blank line and heading `render` only emits when handed a non-empty
/// `host_limits` — the leading `\n` is part of the marker on purpose, because
/// it is the separator `render` adds *before* the heading, and dropping it
/// would leave that one byte outside what either side of the comparison
/// below accounts for. Calling `render` with no `host_limits`, as this test
/// does, produces exactly the text before this marker, if the golden carries
/// it at all.
const HOST_SECTION_BOUNDARY: &str = "\n## What the product cannot observe";

#[test]
fn md39_5_coverage_page_matches_the_capability_table() {
    let table = rigger_grammar::table();
    let rendered = render(&table, &[]);
    let golden_path = golden_path();

    let golden = std::fs::read_to_string(&golden_path).unwrap_or_else(|err| {
        panic!(
            "cannot read the golden at {} — has it been generated at all? {err}",
            golden_path.display()
        )
    });

    let golden_grammar_section = match golden.find(HOST_SECTION_BOUNDARY) {
        Some(boundary) => &golden[..boundary],
        None => golden.as_str(),
    };

    assert_eq!(
        rendered, golden_grammar_section,
        "the grammar-derived portion of docs/coverage.md (everything before \"{HOST_SECTION_BOUNDARY}\") \
         no longer matches the page rendered from `table()`. If this divergence is expected, \
         regenerate the whole committed file with `cargo run -p rigger-cli -- coverage > \
         docs/coverage.md` and say, in the change that does it, what moved in `table()` to \
         justify the new page — never hand-edit the golden to make this test pass without knowing \
         why it was red"
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
