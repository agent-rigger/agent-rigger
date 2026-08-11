//! The witness that each `#[must_use]` of this crate is still measured.
//!
//! **Three values carry one, and each is refused by a pair of examples rather
//! than by an assertion.** A `compile_fail` block drops the value and must not
//! build; its twin keeps it and must. The pair lives in the doc comment of the
//! function that hands the value back — `Registry::reread`, `Backup::take` and
//! `transact`.
//!
//! **What this guard adds is the only thing the pairs cannot hold: their own
//! existence.** Delete an attribute and its `compile_fail` starts compiling, so
//! the doctest goes red by itself — the attributes need nothing from here.
//! Delete the doc block instead and nothing anywhere goes red: the requirement
//! stays ticked while measuring nothing. That is what is anchored below.
//!
//! It is anchored **on the declaration and not on the file**. A count of fences
//! over a whole source goes green on fences moved onto any other item in it, and
//! `transaction.rs` carries other examples than these.
//!
//! **The helpers below are a second copy of the ones in `rigger-apply`, and that
//! is deliberate.** Sharing them would mean one of these crates reading the
//! other's source tree, or a dependency between two test suites that have no
//! other reason to know about each other. Two copies of thirty lines is the
//! cheaper of the two, and the threshold for extracting them is still ahead.
//!
//! **What it cannot see**: that a `compile_fail` fails for the dropped value
//! rather than for a typo somebody left in it. `compile_fail` asserts that a
//! block does not build, never that it does not build for the stated reason, and
//! a promoted lint carries no error code to narrow it with. The twin covers most
//! of that — a typo in an import shared by both turns the twin red — and the
//! rest is covered by removing each attribute by hand and watching exactly one
//! pair go red, which is a gesture of the slice rather than something a test
//! holds.

use std::path::Path;

/// The lines immediately above a declaration: its doc block and its attributes,
/// in source order.
///
/// Anchored on the declaration, so that a fence moved onto another item stops
/// counting for this one.
fn preamble(source: &str, declaration: &str) -> String {
    let at = source
        .find(declaration)
        .unwrap_or_else(|| panic!("`{}` must still be declared here", declaration.trim()));
    let mut block: Vec<&str> = source[..at]
        .lines()
        .rev()
        .take_while(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("///") || trimmed.starts_with("#[")
        })
        .collect();
    block.reverse();
    block.join("\n")
}

/// The info string of every fenced example in a doc block, in order.
///
/// Opening and closing fences are told apart by alternation, which is what the
/// format itself does: a closing fence carries no info string and would
/// otherwise be counted as one more example that runs.
fn fenced_examples(doc: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut inside = false;
    for line in doc.lines() {
        let Some(content) = line.trim_start().strip_prefix("///") else {
            continue;
        };
        let Some(info) = content.trim().strip_prefix("```") else {
            continue;
        };
        if inside {
            inside = false;
        } else {
            inside = true;
            found.push(info.trim().to_string());
        }
    }
    found
}

fn source(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(name))
        .expect("read the crate's own source")
}

#[test]
fn guard_every_must_use_of_this_crate_still_carries_the_pair_that_measures_it() {
    let transaction = source("src/transaction.rs");
    let backup = source("src/backup.rs");

    for (declaration, doc) in [
        (
            "Registry::reread",
            preamble(&transaction, "\n    pub fn reread"),
        ),
        ("Backup::take", preamble(&backup, "\n    pub fn take(")),
        ("transact", preamble(&transaction, "\npub fn transact(")),
    ] {
        assert_eq!(
            fenced_examples(&doc),
            vec!["compile_fail".to_string(), "no_run".to_string()],
            "the doc block of `{declaration}` no longer carries the refusal that drops the value \
             and the twin that keeps it — the attribute on the value it hands back is then held by \
             nothing, and dropping that value goes back to compiling in silence"
        );
    }
}
