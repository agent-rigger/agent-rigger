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

/// The exit code for a request that cannot be satisfied — here, anything that
/// is not the one command this binary knows.
///
/// **It is not chosen here.** The product's exit-code contract is ratified
/// elsewhere and is four values wide: `0` success or a deliberate refusal, `1`
/// a legitimate request the runtime failed, `2` a request that cannot be
/// satisfied, `130` an interruption — plus one carve-out, `3`, held by a
/// diagnostic. An unknown flag is named in that contract as an example of `2`.
/// Naming the value here rather than writing it inline is what lets the
/// assertion below exist at all.
const REQUEST_CANNOT_BE_SATISFIED: u8 = 2;

/// The contract's values, as ratified.
const RATIFIED_EXIT_CODES: [u8; 4] = [0, 1, 2, 130];

/// **A compile-time lock, and a narrow one — read what it does not do.** It
/// refuses to build if a code *declared above* leaves the ratified table. It
/// says nothing about a value written inline at a `return`: Rust cannot
/// enumerate what a function may produce, so the day a branch answers `4`
/// without going through a constant, nothing here goes red. What closes that
/// gap is the integration suite, which replays every invocation this binary
/// accepts and pins the code each one returns.
const _: () = assert!(
    RATIFIED_EXIT_CODES[2] == REQUEST_CANNOT_BE_SATISFIED,
    "the refusal code must be the contract's `request that cannot be satisfied`"
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
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("rigger-cli: cannot write to stdout: {err}");
            ExitCode::FAILURE
        }
    }
}
