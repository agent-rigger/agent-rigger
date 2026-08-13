//! The witness that each `#[must_use]` of the write path is still measured.
//!
//! **Three values carry one, and each is refused by a pair of examples rather
//! than by an assertion.** A `compile_fail` block drops the value and must not
//! build; its twin keeps it and must. The pair is the measurement, and it lives
//! in the doc comment of the function that hands the value back — `stage`,
//! `pose`, and `merge_into_file`.
//!
//! **What this guard adds is the only thing the pairs cannot hold: their own
//! existence.** Delete an attribute and its `compile_fail` starts compiling, so
//! the doctest goes red on its own — the attributes need nothing from here.
//! Delete the doc block instead and nothing anywhere goes red: the requirement
//! stays ticked while measuring nothing. That is what is anchored below.
//!
//! It is anchored **on the declaration and not on the file**, which is the
//! detail that makes it work. A count of fences over a whole source goes green
//! on fences that have been moved onto any other item in it, and would keep
//! reporting three pairs long after the three were gone.
//!
//! **What it cannot see**, stated so that nobody reads more into it: that a
//! `compile_fail` fails for the dropped value rather than for a typo somebody
//! left in it. `compile_fail` asserts that a block does not build, never that it
//! does not build for the stated reason, and a promoted lint carries no error
//! code to narrow it with. The twin is what covers most of that — a typo in an
//! import shared by both turns the twin red — and the rest is covered by
//! removing the attribute by hand and watching the pair, which is a gesture of
//! the slice and not something a test can hold.

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
fn guard_every_must_use_of_the_write_path_still_carries_the_pair_that_measures_it() {
    let txn = source("src/txn.rs");
    let pose = source("src/pose.rs");

    for (declaration, doc) in [
        ("pub fn stage", preamble(&txn, "\npub fn stage(")),
        ("pub fn pose", preamble(&pose, "\npub fn pose(")),
        (
            "pub fn merge_into_file",
            preamble(&txn, "\npub fn merge_into_file"),
        ),
    ] {
        let examples = fenced_examples(&doc);
        let refusal_and_twin = match examples.as_slice() {
            // The refusal may carry a measured error code or lint name after a
            // comma (`compile_fail,E0451`, `compile_fail,unused_must_use`) —
            // that suffix is documentation, never part of what this guard
            // measures. `compile_fail` on its own is refused just the same.
            [refusal, twin] => {
                (refusal == "compile_fail" || refusal.starts_with("compile_fail,"))
                    && twin == "no_run"
            }
            _ => false,
        };
        assert!(
            refusal_and_twin,
            "the doc block of `{declaration}` no longer carries the refusal that drops the value \
             and the twin that keeps it — the attribute on the value it hands back is then held by \
             nothing, and dropping that value goes back to compiling in silence: {examples:?}"
        );
    }
}
