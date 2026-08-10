//! Enumerates the documents of `tests/corpus/` and writes the list that
//! `src/capability.rs` embeds under the name `SHARED_CORPUS`.
//!
//! **Why it is generated rather than written.** Two reasons, and either would
//! be enough.
//!
//! The first is drift. A list written by hand in the source and a directory of
//! documents describe the same set without ever meeting: a document added to
//! the repository and forgotten in the list would never be offered to a
//! grammar, and the measurement would silently fall back on the documents
//! already known. That is the mode the capability table exists to close,
//! transposed to its own instrument.
//!
//! The second is that scenario C7 demands the admission condition derive from
//! a property of the grammar, never from a list of host names — a guard
//! checks the crate's source file by file for exactly that. Enumerating the
//! directory rather than copying it out is what keeps the requirement true
//! over time, not only at the instant it is written: the crate names no
//! document, it takes them all, whatever name a document added tomorrow
//! happens to carry. (Until 2026-08-10, one corpus file carried the name of a
//! host the product no longer serves; nothing here needed to change when it
//! was renamed, which is the point.)

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let corpus = Path::new(&manifest).join("tests/corpus");

    // The whole directory, and not only its files: a document dropped in later
    // must trigger this generation again, failing which the embedded list would
    // be the one of an earlier state of the repository.
    println!("cargo::rerun-if-changed={}", corpus.display());

    let mut documents: Vec<_> = fs::read_dir(&corpus)
        .unwrap_or_else(|err| panic!("{}: corpus directory unreadable — {err}", corpus.display()))
        .map(|entry| entry.expect("readable directory entry").path())
        .filter(|path| path.is_file())
        .collect();
    documents.sort();

    assert!(
        !documents.is_empty(),
        "{}: no document — the capability derivation would lose its second witness",
        corpus.display()
    );

    // Lifetimes are elided: in a constant they are `'static`, and
    // `clippy::redundant_static_lifetimes` refuses to see them written. The
    // generated code passes the same gates as the written code.
    let mut rendered = String::from("pub const SHARED_CORPUS: &[(&str, &str)] = &[\n");
    for path in &documents {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_else(|| panic!("{}: non-UTF-8 file name", path.display()));
        let full_path = path
            .to_str()
            .unwrap_or_else(|| panic!("{}: non-UTF-8 path", path.display()));
        writeln!(rendered, "    ({name:?}, include_str!({full_path:?})),")
            .expect("writing to memory is infallible");
        println!("cargo::rerun-if-changed={full_path}");
    }
    rendered.push_str("];\n");

    let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("shared_corpus.rs");
    fs::write(&out, rendered)
        .unwrap_or_else(|err| panic!("{}: cannot write — {err}", out.display()));
}
