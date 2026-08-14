//! Proves MD-39·3: every observable a caller can script against —
//! standard output, standard error, and exit status — is replayed and
//! compared, not just the one that carries the page.
//!
//! `tests/coverage_command.rs` (MD-39·1) already replays the nominal
//! invocation and compares its stdout to `docs/coverage.md`; it never
//! looks at stderr, and only checks that the exit status counts as
//! success, not its exact value. This file replays each invocation the
//! binary answers to — reading `crates/rigger-cli/src/main.rs`, that is
//! the nominal `coverage` argument and everything that falls through to
//! its `_` arm — and compares all three observables together for each
//! one, so a caller who scripts against `rigger-cli` (checking its exit
//! code, or that it stays silent on stderr when it succeeds) has that
//! contract measured, not assumed.
//!
//! Only two invocations are exercised. A bare invocation with no
//! arguments was measured too: `main`'s `match args.as_slice()` sends it
//! through the same `_` arm as an unknown argument, and running it
//! produces byte-identical stdout, stderr, and exit status to the
//! unknown-argument case below. A third test asserting the same triple
//! again would carry no information a reader does not already have from
//! the refused-invocation test, so it is not written.

use std::path::PathBuf;
use std::process::{Command, Output};

#[test]
fn md39_3_the_nominal_invocation_prints_the_page_and_stays_silent() {
    let output = run(&["coverage"]);

    assert_eq!(
        output.status.code(),
        Some(0),
        "`rigger-cli coverage` exit code, stderr: {}",
        stderr_of(&output)
    );
    assert_eq!(
        stderr_of(&output),
        "",
        "`rigger-cli coverage` wrote to stderr on its success path"
    );

    // Reuses the golden `tests/coverage_command.rs` (MD-39·1) already
    // compares stdout against, rather than a fixture of this file's own —
    // the same choice that test made against
    // `crates/rigger-grammar/tests/coverage.rs`, for the same reason: one
    // committed page, not two copies of it that can drift apart. Replaying
    // the comparison here, instead of leaving it only to that file, is
    // what lets this test hold the nominal invocation's three observables
    // together, which is what MD-39·3 asks for; the shared golden is what
    // keeps that from becoming a second, possibly-diverging, truth.
    assert_eq!(
        normalize_line_endings(&stdout_of(&output)),
        normalize_line_endings(&golden()),
        "`rigger-cli coverage` no longer prints docs/coverage.md"
    );
}

#[test]
fn md39_3_an_unknown_argument_is_refused_on_stderr_with_a_nonzero_exit() {
    let output = run(&["bogus"]);

    assert_eq!(
        output.status.code(),
        Some(2),
        "`rigger-cli bogus` exit code, stdout: {}, stderr: {}",
        stdout_of(&output),
        stderr_of(&output)
    );
    assert_eq!(
        stdout_of(&output),
        "",
        "a refused invocation printed part of the page anyway"
    );
    assert_eq!(
        stderr_of(&output),
        "usage: rigger-cli coverage install <catalog> <entry-id> remove <entry-id>\n",
        "the usage line `main.rs` prints on refusal has changed"
    );
}

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rigger-cli"))
        .args(args)
        .output()
        .unwrap_or_else(|err| panic!("cannot run the `rigger-cli` binary with {args:?}: {err}"))
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8(output.stdout.clone())
        .unwrap_or_else(|err| panic!("the command's stdout is not UTF-8: {err}"))
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8(output.stderr.clone())
        .unwrap_or_else(|err| panic!("the command's stderr is not UTF-8: {err}"))
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// `agent-rigger/docs/coverage.md`, reached from this crate's manifest
/// directory so the test does not depend on the working directory it runs
/// from — the same convention `tests/coverage_command.rs` uses.
fn golden() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("docs")
        .join("coverage.md");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("cannot read the golden at {}: {err}", path.display()))
}
