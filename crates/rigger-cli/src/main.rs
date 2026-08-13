//! The product's one entry point today: a binary carrying a single command,
//! `coverage`, which prints `docs/coverage.md` as rendered from the measured
//! capability table and the limits no grammar's table can carry.
//!
//! **What MD-39·1 requires, and how this closes it.** The published output
//! must be produced by running the command — never prose written by hand.
//! `coverage` prints exactly what
//! `rigger_grammar::coverage::render(&rigger_grammar::table(), &host_limits)`
//! returns — the rendering `crates/rigger-grammar/src/coverage.rs` made a
//! production caller for — and `tests/coverage_command.rs` runs the compiled
//! binary and compares its stdout to the committed page.
//!
//! **Why this binary, not `rigger-grammar`, names the host limit.** MD-40's
//! closing admission — the product will never know at what granularity a
//! host loads what it posed — is not a property of any grammar, so it does
//! not come from `table()`. `rigger-apply` states it, as
//! `UNOBSERVED_LOAD_GRANULARITY`, because that is the crate that actually
//! poses files and records their trace; this binary is the composition root
//! that already depends on `rigger-grammar` for the table, so it is where
//! the two meet.
//!
//! **Why one command.** This crate exists to establish that mechanism, not to
//! carry a full command surface; a fuller one is not decided here.

use std::io::Write;
use std::process::ExitCode;

/// Whether `code` is one the product's exit-code contract ratifies.
///
/// **This is a transcription, and nothing here can check it.** The contract
/// lives in a decision record, in prose, in a repository this crate does not
/// carry: `0` success or a deliberate refusal, `1` a legitimate request the
/// runtime failed, `2` a request that cannot be satisfied, `130` an
/// interruption — plus one carve-out, `3`, held by a diagnostic and not by
/// this binary. Copying those values here is the only way a compiler can see
/// them; it also means a wrong copy compiles. What the assertions below buy
/// is that the codes this file returns cannot drift **away from the copy**,
/// not that the copy is right.
///
/// An earlier form of this compared one constant to one slot of an array and
/// called itself a membership test. Reordering the array broke the build while
/// the codes stayed ratified, and putting an unratified value in both places
/// left it green — it tested an equality, not a belonging. A closing review
/// measured both.
const fn is_ratified(code: u8) -> bool {
    matches!(code, 0 | 1 | 2 | 130)
}

/// Success: the page was written to stdout in full.
const SUCCESS: u8 = 0;

/// A legitimate request the runtime failed — here, stdout refusing the write.
const RUNTIME_FAILURE: u8 = 1;

/// A request that cannot be satisfied — anything that is not the one command
/// this binary knows. The contract names an unknown flag as its example.
const REQUEST_CANNOT_BE_SATISFIED: u8 = 2;

/// **A compile-time lock, and a narrow one — read what it does not do.** It
/// refuses to build if a code named above leaves the transcribed contract. It
/// says nothing about a value written inline at a `return`: Rust cannot
/// enumerate what a function may produce, so the day a branch answers `9`
/// without going through a constant, nothing here goes red. What covers that
/// gap is the integration suite, which replays every invocation this binary
/// accepts and pins the code each one returns — measured: an inline `9` leaves
/// this assertion silent and reddens the replay.
const _: () = assert!(
    is_ratified(SUCCESS)
        && is_ratified(RUNTIME_FAILURE)
        && is_ratified(REQUEST_CANNOT_BE_SATISFIED),
    "an exit code this binary returns is outside the ratified contract"
);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command] if command == "coverage" => coverage(),
        _ => {
            eprintln!("usage: rigger-cli coverage");
            ExitCode::from(REQUEST_CANNOT_BE_SATISFIED)
        }
    }
}

/// Prints `rigger_grammar::coverage::render`'s page for the crate's measured
/// table, plus the limits `rigger-apply` names outside any grammar, to
/// stdout unmodified.
fn coverage() -> ExitCode {
    let table = rigger_grammar::table();
    let host_limits = [rigger_apply::UNOBSERVED_LOAD_GRANULARITY];
    let page = rigger_grammar::coverage::render(&table, &host_limits);
    match std::io::stdout().write_all(page.as_bytes()) {
        Ok(()) => ExitCode::from(SUCCESS),
        Err(err) => {
            eprintln!("rigger-cli: cannot write to stdout: {err}");
            ExitCode::from(RUNTIME_FAILURE)
        }
    }
}
