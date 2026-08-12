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
//! **Why the rendering is called here and not owned here.** It used to be:
//! `table()` had no production caller, and this test was the only thing that
//! could run the derivation, so H1 wrote the rendering here under its own
//! mandate — no production line. `crates/rigger_grammar::coverage` now owns
//! it, `pub`, because `crates/rigger-cli` calls it too and a binary in
//! another crate cannot reach into this crate's tests. This file is the
//! rendering's appellant, not its owner: it still measures the one thing
//! neither `capability.rs` nor the CLI's own test can — that the committed
//! page matches the table byte for byte.
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

use rigger_grammar::coverage::render;

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
