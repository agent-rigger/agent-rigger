//! The product's one entry point today: a binary carrying a single command,
//! `coverage`, which prints `docs/coverage.md` as rendered from the measured
//! capability table.
//!
//! **What MD-39·1 requires, and how this closes it.** The published output
//! must be produced by running the command — never prose written by hand.
//! `coverage` prints exactly what
//! `rigger_grammar::coverage::render(&rigger_grammar::table())` returns —
//! the rendering `crates/rigger-grammar/src/coverage.rs` made a production
//! caller for — and `tests/coverage_command.rs` runs the compiled binary and
//! compares its stdout to the committed page.
//!
//! **Why one command.** This crate exists to establish that mechanism, not to
//! carry a full command surface; a fuller one is not decided here.

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command] if command == "coverage" => coverage(),
        _ => {
            eprintln!("usage: rigger-cli coverage");
            ExitCode::from(2)
        }
    }
}

/// Prints `rigger_grammar::coverage::render`'s page for the crate's measured
/// table, unmodified, to stdout.
fn coverage() -> ExitCode {
    let table = rigger_grammar::table();
    let page = rigger_grammar::coverage::render(&table);
    match std::io::stdout().write_all(page.as_bytes()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("rigger-cli: cannot write to stdout: {err}");
            ExitCode::FAILURE
        }
    }
}
