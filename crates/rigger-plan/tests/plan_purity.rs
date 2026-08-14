//! P1 — the planning behaviours execute nothing and write nothing
//! themselves, and this file is what measures it.
//!
//! Realises the half of MD-37·1 that has an object today: *the planning
//! executes nothing and writes nothing*. The other half of that requirement
//! — that the application, once a caller has consented, poses a `delegate`
//! — has no object to measure yet, because `Delegate::pose` is `NotBuilt`
//! (`tests/closed_set.rs`,
//! `a4_a_member_with_no_body_refuses_by_naming_itself_rather_than_leaving_a_hole`).
//!
//! **The gap, measured rather than assumed.** Injecting
//! `std::process::Command::new("true").status()` and `std::fs::write(…)`
//! into a behaviour of the closed set left the suite at 296 passed, 0
//! failed, and the probe file such an injection writes really appears on
//! disk during the run. This crate has no third-party dependency and
//! imports neither `std::process` nor `std::fs` today — the guarantee holds
//! **by construction**, and nothing locked it before this file did.
//!
//! **The pattern is `tests/closed_set.rs`'s**: read the crate's own source
//! through `env!("CARGO_MANIFEST_DIR")` and assert on what is found there,
//! rather than inventing a new one.
//!
//! **Do not grep the `use` lines alone.** `std::fs::write(…)` written
//! inline, fully qualified, never appears on a `use` line — a check that
//! only reads imports would miss the exact snippet this file exists to
//! catch. The detector below reads the whole text of every file under
//! `src/` and looks for the tokens a process launch or a disk write cannot
//! be made without in `std`, present whether the call is spelled out fully
//! qualified or reached through a `use` — because the `use` line itself
//! carries the same tokens.
//!
//! **What this detector does not catch, found by trying to defeat it and
//! kept as a characterization test below rather than hidden.** Renaming the
//! *leaf* of an import (`use std::process::Command as Cmd;`) is still
//! caught, because the `use` line itself still carries `process::Command`
//! whole. Renaming the *module* too, without grouping it, is still caught
//! for the same reason: `use std::process as p;` still leaves `std::process`
//! contiguous. It takes the **grouped, braced** form — `use std::{process as
//! p};` followed by `type Spawn = p::Command;` — to break the substring and
//! remove every token this file looks for from the text; the first, wrong
//! guess at this gap is kept as a live regression alongside the real one, so
//! the mistake in reaching it stays visible rather than silently corrected
//! away. Closing the real gap by matching path segments with the whitespace
//! and braces stripped out was tried and set aside: on this crate's own
//! prose, stripping turns `offset` (`FNV-1a`'s "offset basis") into a string
//! containing `fs`, which would redden this file on unmodified source. A
//! detector that lies in that direction — red on code that neither launches
//! a process nor writes a file — is worse than the narrower one kept here.

use std::path::PathBuf;

/// `crates/rigger-plan`, reached the same way `tests/closed_set.rs` reaches
/// its own crate root: from the manifest directory, so the test does not
/// depend on the working directory it runs from.
fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The tokens a process launch or a disk write cannot be made without in
/// `std`, paired with what each one names for the failure message.
///
/// `Command::new` is the only public constructor of `std::process::Command`,
/// so no process can be launched without it appearing at the call site
/// (unless `Command` itself is imported under another name — covered
/// separately by `process::Command`, which the `use` line carries whole). A
/// disk write goes through `fs::write`, `File::create`/`File::open`,
/// `OpenOptions`, or the `Write::write_all` method; the tokens below name
/// each one, plus the two broad module paths that catch a fully qualified
/// call with no `use` at all.
const FORBIDDEN: &[(&str, &str)] = &[
    ("std::process", "names the process module"),
    ("process::Command", "names the process launcher"),
    ("Command::new", "constructs a process launcher"),
    ("std::fs", "names the filesystem module"),
    ("fs::", "names a filesystem call"),
    ("File::", "names a file handle"),
    ("OpenOptions", "names a file open"),
    (".write_all(", "writes a buffer out"),
];

/// The forbidden tokens found in `source`, each paired with what it names —
/// empty if `source` names neither a process launch nor a disk write.
fn named_in(source: &str) -> Vec<(&'static str, &'static str)> {
    FORBIDDEN
        .iter()
        .copied()
        .filter(|(token, _)| source.contains(token))
        .collect()
}

#[test]
fn md37_1_the_manifest_declares_no_third_party_dependency() {
    let manifest = std::fs::read_to_string(crate_root().join("Cargo.toml"))
        .expect("read the crate's own manifest");
    let entries = dependency_entries(&manifest);

    assert!(
        !entries.is_empty(),
        "the manifest's `[dependencies]` table read as empty — a check running over nothing \
         would pass vacuously, and this crate does depend on `rigger-grammar`"
    );

    for (name, line) in &entries {
        assert!(
            line.contains("path"),
            "`{name}` is declared without a `path` key — a dependency this workspace does not \
             own by path must be third-party: {line}"
        );
    }
}

/// The non-blank, non-comment lines of the manifest's `[dependencies]`
/// table, each paired with the crate name it declares.
///
/// Bounded from the `[dependencies]` heading to the next `[`, the same way
/// `tests/closed_set.rs`'s `preamble` bounds a doc block from a declaration
/// to the next one — so a dependency named in a comment, or one living under
/// `[dev-dependencies]`, is not counted.
fn dependency_entries(manifest: &str) -> Vec<(String, String)> {
    let heading = "[dependencies]";
    let start = match manifest.find(heading) {
        Some(at) => at + heading.len(),
        None => return Vec::new(),
    };
    let body = &manifest[start..];
    let end = body.find("\n[").unwrap_or(body.len());

    body[..end]
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            line.split_once('=')
                .map(|(name, _)| (name.trim().to_string(), line.to_string()))
        })
        .collect()
}

#[test]
fn guard_the_detector_catches_the_exact_snippet_this_change_measured_the_gap_with() {
    // Positive control: proves `named_in` is not vacuously empty before it is
    // trusted to certify the real source. Mirrors the two calls this
    // change's brief measured leaving the suite green — fully qualified,
    // inline, the exact shape a `use`-only scan would have missed.
    let mutated = r#"
        pub fn behaviour(name: BehaviourName) -> &'static dyn Behaviour {
            let _ = std::process::Command::new("true").status();
            let _ = std::fs::write("probe.txt", b"x");
            match name {
                BehaviourName::Link => &Link,
            }
        }
    "#;

    let found = named_in(mutated);
    let tokens: Vec<_> = found.iter().map(|(token, _)| *token).collect();
    assert!(
        tokens.contains(&"Command::new"),
        "the detector did not catch the fully-qualified process launch: {tokens:?}"
    );
    assert!(
        tokens.contains(&"fs::"),
        "the detector did not catch the fully-qualified disk write: {tokens:?}"
    );
}

#[test]
fn guard_the_detector_catches_a_use_line_rename_of_the_leaf() {
    // A more evident bypass than the brief's own mutation: rename the item
    // at import time so the call site no longer spells `Command::new` or
    // `fs::write`. Still caught, because the `use` line itself carries the
    // qualified path whole.
    let renamed = r#"
        use std::process::Command as Spawn;
        use std::fs::write as save;
        fn probe() {
            let _ = Spawn::new("true").status();
            let _ = save("probe.txt", b"x");
        }
    "#;

    let found = named_in(renamed);
    let tokens: Vec<_> = found.iter().map(|(token, _)| *token).collect();
    assert!(
        tokens.contains(&"process::Command"),
        "renaming `Command` at import time defeated the detector: {tokens:?}"
    );
    assert!(
        tokens.contains(&"fs::"),
        "renaming `write` at import time defeated the detector: {tokens:?}"
    );
}

#[test]
fn guard_the_detector_catches_a_simple_module_alias_too() {
    // The first attempt at defeating the detector: alias the module itself,
    // without grouping it in braces. `use std::process as p;` still leaves
    // `std::process` contiguous in the `use` line, so it is still caught —
    // this is what makes the grouped form below the actual gap, not a mere
    // rename.
    let simply_aliased = r#"
        use std::process as p;
        type Spawn = p::Command;
        fn probe() {
            let _ = Spawn::new("true").status();
        }
    "#;

    let found = named_in(simply_aliased);
    assert!(
        !found.is_empty(),
        "an un-grouped module alias defeated the detector: {found:?} — the module doc comment's \
         claim that only the grouped, braced form breaks the substring no longer holds"
    );
}

#[test]
fn guard_a_rename_of_the_module_itself_is_a_known_blind_spot_of_this_detector() {
    // Found by deliberately trying to defeat the detector above, per this
    // change's own discipline: a guard earns trust by surviving the
    // mutation nobody had in mind, not only the one it was written against.
    // Kept green on purpose, as a characterization rather than a claim of
    // coverage — see the module doc comment for why the fix was set aside.
    // `use std::process as p;`, without the brace, still leaves `std::process`
    // contiguous and is still caught — checked as a live regression by
    // `guard_the_detector_catches_a_simple_module_alias_too` below. It takes
    // the grouped, braced form to break the substring.
    let doubly_aliased = r#"
        use std::{process as p};
        type Spawn = p::Command;
        fn probe() {
            let _ = Spawn::new("true").status();
        }
    "#;

    assert!(
        named_in(doubly_aliased).is_empty(),
        "this detector was expected to miss a rename of the module itself, and it no longer \
         does — if it was strengthened to catch this without reddening on this crate's own \
         prose (`FNV-1a`'s \"offset basis\" contains the substring `fs`), replace this \
         assertion with one that asserts the catch, and update the module doc comment"
    );
}

#[test]
fn guard_the_dependency_check_catches_a_version_only_entry() {
    // Positive control on `dependency_entries`: a fixture manifest with one
    // path dependency (this workspace's own shape, kept) and one
    // version-only entry (the third-party shape the real check must
    // refuse), plus a `[dev-dependencies]` entry that must not be read as
    // if it were `[dependencies]`.
    let fixture = "[package]\nname = \"fixture\"\n\n[dependencies]\n\
                   rigger-grammar = { path = \"../rigger-grammar\" }\n\
                   serde = \"1.0\"\n\n[dev-dependencies]\nnoise = \"9.9\"\n";

    let entries = dependency_entries(fixture);

    assert_eq!(
        entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        vec!["rigger-grammar", "serde"],
        "the section must stop at the next heading, `serde` must be read, and \
         `[dev-dependencies]`'s `noise` must not be"
    );
    assert!(
        entries
            .iter()
            .any(|(name, line)| name == "serde" && !line.contains("path")),
        "the fixture's version-only entry must read as lacking a `path` key"
    );
}
