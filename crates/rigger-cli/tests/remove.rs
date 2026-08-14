//! T2 of the bout-en-bout change: end-to-end proof that `rigger-cli remove`
//! takes the machine back to what it was before `rigger-cli install` changed
//! it — run as a black box, the compiled binary invoked twice against a real
//! filesystem, never by reading `crates/rigger-cli/src/remove.rs`.
//!
//! **What "back to what it was" means here, and what it does not.** The
//! comparison is over what the two commands actually change on a caller's
//! behalf: the address `install` poses at, and the shared store entry behind
//! it. It is not over `.rigger/` itself, which the product keeps — empty of
//! entries once every one of them is removed, but present — for the same
//! reason `rigger-registry/tests/tracer_bullet.rs`'s own `Machine` draws a
//! line between `disk/`, which must return byte for byte, and `state/`, the
//! registry the product owns and does not undo the existence of.
//!
//! **Only a link is exercised, not a merge into a pre-existing document.**
//! `rigger-cli install` poses every entry through `BehaviourName::Link` —
//! see its own module doc comment for why — so a merge into a file that
//! already held content is not a path this binary can reach yet, and this
//! file does not claim to measure it.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A working root this file owns, and the catalogue beside it — both
/// removed once the test that built it is done with them.
struct Scratch {
    base: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let base =
            std::env::temp_dir().join(format!("rigger-cli-remove-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("root")).expect("create the working root");
        Self { base }
    }

    fn root(&self) -> PathBuf {
        self.base.join("root")
    }

    /// Writes a one-entry, `format = 1` catalogue naming `id`, and the
    /// `hooks/<id>.ts` file ADR-0048's nature rule resolves it to, so
    /// `install` has a real artefact to read — returns the catalogue's
    /// path, the one shape `crates/rigger-cli/src/descriptor.rs` reads.
    fn catalogue(&self, id: &str) -> PathBuf {
        let path = self.base.join("catalog.toml");
        std::fs::write(
            &path,
            format!(
                "format = 1\n\n[meta]\nname = \"acme\"\n\n[[entries]]\nkind = \"hook\"\nid = \
                 \"{id}\"\nnature = \"hook\"\n"
            ),
        )
        .expect("write the catalogue");
        let hooks = self.base.join("hooks");
        std::fs::create_dir_all(&hooks).expect("create the hooks folder");
        std::fs::write(
            hooks.join(format!("{id}.ts")),
            "console.log(\"review-checklist\");\n",
        )
        .expect("write the real artefact");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rigger-cli"))
        .args(args)
        .current_dir(root)
        .output()
        .unwrap_or_else(|err| panic!("cannot run `rigger-cli {args:?}`: {err}"))
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8(output.stdout.clone())
        .unwrap_or_else(|err| panic!("the command's stdout is not UTF-8: {err}"))
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8(output.stderr.clone())
        .unwrap_or_else(|err| panic!("the command's stderr is not UTF-8: {err}"))
}

/// The names directly under `root`, sorted — `.rigger` included rather than
/// filtered out, so its persistence past a removal is visible in the
/// comparison instead of hidden from it.
fn top_level(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .expect("read the root")
        .map(|entry| {
            entry
                .expect("read an entry")
                .file_name()
                .to_string_lossy()
                .to_string()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn removing_what_was_installed_takes_the_machine_back_to_its_prior_state() {
    let scratch = Scratch::new("round-trip");
    let root = scratch.root();
    let catalogue = scratch.catalogue("review-checklist");

    assert_eq!(
        top_level(&root),
        Vec::<String>::new(),
        "the scratch root was not empty before `install` ever ran"
    );

    let installed = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "review-checklist"],
    );
    assert_eq!(
        installed.status.code(),
        Some(0),
        "`rigger-cli install` exit code, stderr: {}",
        stderr_of(&installed)
    );
    assert!(
        root.join("review-checklist").exists(),
        "`rigger-cli install` did not pose `review-checklist` at the root"
    );
    let store_entry = root.join(".rigger").join("store").join("review-checklist");
    assert!(
        store_entry.exists(),
        "`rigger-cli install` did not materialise the shared store entry"
    );

    let removed = run(&root, &["remove", "review-checklist"]);
    assert_eq!(
        removed.status.code(),
        Some(0),
        "`rigger-cli remove` exit code, stdout: {}, stderr: {}",
        stdout_of(&removed),
        stderr_of(&removed)
    );
    assert_eq!(
        stderr_of(&removed),
        "",
        "`rigger-cli remove` wrote to stderr on its success path"
    );
    assert!(
        !root.join("review-checklist").exists(),
        "`rigger-cli remove` left `review-checklist` on disk"
    );
    assert!(
        !store_entry.exists(),
        "`rigger-cli remove` left the shared store entry behind, though it was the last thing \
         designating it"
    );

    assert_eq!(
        top_level(&root),
        vec![".rigger".to_string()],
        "the root carries something other than the product's own bookkeeping once the round trip \
         is done"
    );
}

#[test]
fn removing_an_id_the_registry_does_not_know_is_refused() {
    let scratch = Scratch::new("unknown-id");
    let root = scratch.root();

    let output = run(&root, &["remove", "never-installed"]);

    assert_eq!(
        output.status.code(),
        Some(2),
        "exit code for an id the registry never recorded, stdout: {}",
        stdout_of(&output)
    );
    assert_eq!(
        stdout_of(&output),
        "",
        "a refused removal printed on stdout"
    );
    assert_eq!(
        stderr_of(&output),
        "rigger-cli: no entry named `never-installed` in the registry\n"
    );
}
