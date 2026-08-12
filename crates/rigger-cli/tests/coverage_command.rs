//! Proves MD-39·1 on the one command this crate carries: the published
//! output must be produced by **running** the command, never prose written by
//! hand.
//!
//! Runs the compiled `rigger-cli coverage` binary and compares its stdout to
//! `docs/coverage.md` — the same golden `crates/rigger-grammar/tests/coverage.rs`
//! measures the rendering against. Reusing that golden, rather than a second
//! fixture of its own, is what keeps this test asking "does running the
//! command reproduce the page H1's golden already proved correct?" instead of
//! a question with its own, possibly drifting, answer.

use std::path::PathBuf;
use std::process::Command;

#[test]
fn md39_1_the_coverage_command_prints_the_published_page() {
    let output = Command::new(env!("CARGO_BIN_EXE_rigger-cli"))
        .arg("coverage")
        .output()
        .unwrap_or_else(|err| panic!("cannot run the `rigger-cli coverage` binary: {err}"));

    assert!(
        output.status.success(),
        "`rigger-cli coverage` exited with {}, stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );

    let printed = String::from_utf8(output.stdout)
        .unwrap_or_else(|err| panic!("the command's stdout is not UTF-8: {err}"));

    let golden = std::fs::read_to_string(golden_path())
        .unwrap_or_else(|err| panic!("cannot read the golden at docs/coverage.md: {err}"));

    // Normalized on line endings only. `crates/rigger-grammar/tests/coverage.rs`
    // already demands the rendering itself be byte for byte identical to the
    // committed page; this test asks a different question — that *running
    // the command* reproduces it — and the one layer between `render`'s bytes
    // and this assertion that this test does not own is the platform's
    // process pipe. Normalizing CRLF keeps that layer from being what the
    // assertion is actually measuring.
    assert_eq!(
        normalize_line_endings(&printed),
        normalize_line_endings(&golden),
        "`rigger-cli coverage` no longer prints docs/coverage.md"
    );
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// `agent-rigger/docs/coverage.md`, reached from this crate's manifest
/// directory so the test does not depend on the working directory it runs
/// from — the same convention `crates/rigger-grammar/tests/coverage.rs` uses.
fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("coverage.md")
}
