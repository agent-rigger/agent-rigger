//! P2 — every command the binary accepts is named by its usage line, and
//! this file is what measures it.
//!
//! **The gap, measured rather than assumed.** Adding
//! `[command] if command == "version" => …` to the `match` in `main()`,
//! without touching the usage text, leaves the suite green:
//! `tests/recording.rs` pins the literal `"usage: rigger-cli coverage\n"`
//! under a message that says it watches "the usage line `main.rs` prints on
//! refusal" — it watches the string, never the derivation from what the
//! binary actually accepts.
//!
//! **What this file establishes, and what it does not — stated here because
//! a guard's reach lives where it is written, not in a reader's
//! assumption.**
//!
//! - It establishes that every command `main`'s `match` **accepts** is
//!   **named** by the usage line printed on refusal.
//! - It does **not** establish the inverse: a usage line naming a command
//!   the binary does not accept — an over-broad help text — produces no
//!   accepted-but-unnamed pair and passes this check untouched.
//!   `guard_a_usage_line_naming_an_absent_command_is_not_caught_by_this_check`
//!   demonstrates the asymmetry rather than only asserting it in prose.
//! - It does **not** realise the register's clause on non-interactive
//!   prompts — `07-registre-modes-de-defaillance.md`'s MD-83·5, whose source
//!   wording asks that *the command's help message propose no formulation
//!   that leads to a prompt in a non-interactive context*. That clause is
//!   vacuous today: the product carries no prompt at all, so no formulation
//!   of any help text can lead to one. Nothing here measures it, which is
//!   why every test in this file is prefixed `guard_` and none `md83_`.
//!
//! **Scope of the extraction, and the gap found by trying to defeat it.**
//! The detector below reads the `match args.as_slice() { … }` block of
//! `main()` by balanced braces, isolates the wildcard arm (where the usage
//! line lives), and treats every other quoted string literal left in the
//! block as an accepted command. That scan survives both the arm shape the
//! confirming mutation uses (`[command] if command == "X"`) and a more
//! evident one gone looking for on purpose, `[command] if command.as_str()
//! == "X"` — a bare slice-literal pattern (`["X"] => …`) was tried first and
//! does not type-check against `args.as_slice()`'s `&[String]`, `rustc`
//! refusing it with `expected String, found &str`, so it was not a bypass
//! this binary's own types leave open. Both shapes actually tried leave
//! their literal inside the block this file reads.
//!
//! It does **not** survive a command list moved out of the block — a
//! `const` defined elsewhere in the file and consulted through
//! `.contains(...)` inside the guard, so the literal naming the command
//! never appears inside the block this file bounds itself to.
//! `guard_a_command_list_declared_outside_the_match_is_a_known_blind_spot_of_this_detector`
//! keeps that gap measured rather than hidden.
//!
//! Reading the whole file instead of the block was tried and set aside, on
//! a measurement rather than a guess: `main.rs` carries two quoted literals
//! outside the match today, `"an exit code this binary returns is outside
//! the ratified contract"` (the exit-code lock's `assert!`) and
//! `"rigger-cli: cannot write to stdout: {err}"` (an unrelated `eprintln!`
//! inside `coverage()`) — a whole-file scan would count the first of those
//! as an accepted command with no name in the usage line and redden this
//! file on unmodified source.

use std::path::PathBuf;

/// `crates/rigger-cli/src/main.rs`, reached from this crate's manifest
/// directory so the test does not depend on the working directory it runs
/// from — the same convention `tests/coverage_command.rs` uses for the
/// golden it reads.
fn main_rs_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("main.rs")
}

/// The text from `source[open_at..]`'s first `{` to its matching `}`,
/// inclusive of both, found by counting brace depth byte by byte.
///
/// Assumes no `{` or `}` occurs inside a string literal or a comment
/// between the two — true of `main.rs` today, where the only braces in
/// `main`'s body are the ones structuring the `match` itself and the
/// `{err}` interpolation inside a string, which does not carry a literal
/// `{` byte followed by an unmatched `}` at any point outside a balanced
/// pair. A file that grew a literal `{` or `}` inside a string in this span
/// would make this helper misparse, and every test built on it would then
/// measure the wrong span rather than fail outright — the same shape of
/// risk `tests/closed_set.rs`'s `preamble` accepts for the same reason: a
/// full parser is not what a guard like this one is for.
fn brace_block(source: &str, open_at: usize) -> &str {
    let brace_at = source[open_at..]
        .find('{')
        .map(|offset| open_at + offset)
        .unwrap_or_else(|| panic!("no `{{` found from byte {open_at}"));
    let mut depth = 0i32;
    for (offset, byte) in source.as_bytes()[brace_at..].iter().enumerate() {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &source[brace_at..=brace_at + offset];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces from byte {brace_at}");
}

/// The `{ … }` of `match args.as_slice() { … }` in `main()`, braces
/// included.
fn match_body(source: &str) -> &str {
    let anchor = "match args.as_slice() {";
    let at = source
        .find(anchor)
        .unwrap_or_else(|| panic!("`main` must still match on `args.as_slice()`"));
    brace_block(source, at)
}

/// The `{ … }` of the wildcard arm, `_ => { … }`, braces included — the
/// block the usage line is printed from.
fn wildcard_arm(match_body: &str) -> &str {
    let anchor = "_ => {";
    let at = match_body
        .find(anchor)
        .unwrap_or_else(|| panic!("no wildcard arm with a block body found in: {match_body}"));
    brace_block(match_body, at)
}

/// `match_body` with `wildcard`'s span removed — every other arm, where an
/// accepted command's literal lives.
fn non_wildcard_arms<'a>(match_body: &'a str, wildcard: &str) -> std::borrow::Cow<'a, str> {
    match match_body.find(wildcard) {
        Some(at) => {
            let mut without = String::with_capacity(match_body.len() - wildcard.len());
            without.push_str(&match_body[..at]);
            without.push_str(&match_body[at + wildcard.len()..]);
            std::borrow::Cow::Owned(without)
        }
        None => std::borrow::Cow::Borrowed(match_body),
    }
}

/// Every double-quoted string literal in `text`, in order, with no escape
/// handling — sufficient for the one-word command names this file's target
/// carries today.
fn quoted_literals(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut inside = false;
    let mut current = String::new();
    for ch in text.chars() {
        if ch == '"' {
            if inside {
                found.push(std::mem::take(&mut current));
            }
            inside = !inside;
        } else if inside {
            current.push(ch);
        }
    }
    found
}

/// The commands an accepted-command scan finds in every non-wildcard arm of
/// `match_body`.
fn accepted_commands(match_body: &str) -> Vec<String> {
    let wildcard = wildcard_arm(match_body);
    quoted_literals(&non_wildcard_arms(match_body, wildcard))
}

/// The raw text of the first `eprintln!("…"` literal in `wildcard` — the
/// usage line, unescaped.
fn usage_literal(wildcard: &str) -> String {
    let anchor = "eprintln!(\"";
    let at = wildcard
        .find(anchor)
        .unwrap_or_else(|| panic!("no `eprintln!` literal found in the wildcard arm: {wildcard}"));
    let start = at + anchor.len();
    let end = wildcard[start..]
        .find('"')
        .unwrap_or_else(|| panic!("unterminated string after `eprintln!(` in: {wildcard}"));
    wildcard[start..start + end].replace("\\n", "")
}

/// The command names a usage line of the shape `usage: rigger-cli <cmd>
/// [<cmd> …]` names — the flat, space-separated grammar the real line
/// carries today; a usage line that grows bracketed or piped alternatives
/// would need this to change with it.
fn commands_named_by_usage(usage: &str) -> Vec<String> {
    let prefix = "usage: rigger-cli ";
    let after = usage
        .strip_prefix(prefix)
        .unwrap_or_else(|| panic!("the usage line no longer starts with `{prefix}`: {usage}"));
    after.split_whitespace().map(str::to_string).collect()
}

#[test]
fn guard_every_accepted_command_is_named_by_the_usage_line() {
    let source = std::fs::read_to_string(main_rs_path()).expect("read the binary's own source");
    let body = match_body(&source);

    let accepted = accepted_commands(body);
    let usage = usage_literal(wildcard_arm(body));
    let named = commands_named_by_usage(&usage);

    // Contrôle positif obligatoire: an extraction finding no command would
    // pass this check vacuously, the exact mode a plancher left open
    // elsewhere in this repository this week.
    assert!(
        !accepted.is_empty(),
        "the scan found no accepted command in `main`'s `match` — either `main.rs` changed shape \
         or this extraction is vacuous"
    );
    assert!(
        !named.is_empty(),
        "the scan found no command named by the usage line — either `main.rs` changed shape or \
         this extraction is vacuous"
    );

    for command in &accepted {
        assert!(
            named.contains(command),
            "`{command}` is accepted by `main`'s `match` but the usage line does not name it \
             ({named:?}) — a caller refused on an unrelated argument is told nothing about a \
             command the binary would in fact have run"
        );
    }
}

#[test]
fn guard_a_usage_line_naming_an_absent_command_is_not_caught_by_this_check() {
    // States the boundary in code rather than only in prose: this file
    // establishes one direction — every *accepted* command is *named*. A
    // usage line naming a command that is not accepted produces no
    // accepted-but-unnamed pair, so the loop above finds nothing to refuse.
    let accepted = ["coverage".to_string()];
    let named = ["coverage".to_string(), "ghost".to_string()];

    assert!(
        accepted.iter().all(|command| named.contains(command)),
        "the fixture no longer demonstrates the asymmetry this test exists to record: `ghost` is \
         named by `named` without being accepted, and that must not read as a violation"
    );
}

#[test]
fn guard_the_helpers_generalise_past_a_single_command() {
    // Positive control on the helpers themselves, ahead of trusting them on
    // the real file: a fixture shaped like `main` but carrying two accepted
    // commands, both named, and one arm using `command.as_str() == "…"`
    // rather than `main.rs`'s own `command == "…"` guard — the more evident
    // bypass this file went looking for beyond the one the brief measured
    // (a bare slice-literal pattern was tried first and does not compile
    // against `&[String]`, checked live against the real binary before this
    // fixture was written). It does not defeat the scan because both shapes
    // still leave their literal inside the block this file reads.
    let fixture = r#"
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command] if command == "coverage" => coverage(),
        [command] if command.as_str() == "doctor" => doctor(),
        _ => {
            eprintln!("usage: rigger-cli coverage doctor");
            ExitCode::from(REQUEST_CANNOT_BE_SATISFIED)
        }
    }
}
"#;
    let body = match_body(fixture);
    let accepted = accepted_commands(body);
    let named = commands_named_by_usage(&usage_literal(wildcard_arm(body)));

    assert_eq!(accepted, vec!["coverage".to_string(), "doctor".to_string()]);
    assert_eq!(named, vec!["coverage".to_string(), "doctor".to_string()]);
}

#[test]
fn guard_a_command_list_declared_outside_the_match_is_a_known_blind_spot_of_this_detector() {
    // Found by deliberately trying to defeat the detector above, per this
    // change's own discipline: a guard earns trust by surviving the
    // mutation nobody had in mind, not only the one it was written against.
    // Kept green on purpose, as a characterization rather than a claim of
    // coverage — see the module doc comment for why widening the scan to
    // the whole file was tried and set aside instead of closing this.
    let fixture = r#"
const KNOWN: &[&str] = &["coverage", "version"];

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command] if KNOWN.contains(&command.as_str()) => dispatch(command),
        _ => {
            eprintln!("usage: rigger-cli coverage");
            ExitCode::from(REQUEST_CANNOT_BE_SATISFIED)
        }
    }
}
"#;
    let body = match_body(fixture);
    let accepted = accepted_commands(body);

    assert!(
        accepted.is_empty(),
        "this detector was expected to miss a command list declared outside the block it reads, \
         and it no longer does — if it was strengthened to catch this without reintroducing the \
         false positive a whole-file scan produces on `main.rs`'s own `assert!` message, replace \
         this assertion with one that asserts the catch, and update the module doc comment"
    );
}
