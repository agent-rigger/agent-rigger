//! T3 of the bout-en-bout change: `rigger-cli install`'s failure paths, run
//! as a black box against the compiled binary — never by reading
//! `crates/rigger-cli/src/install.rs`.
//!
//! **What this closes.** A catalogue's `id` is data `install` reads, not
//! data it wrote — before this change, nothing between that read and the
//! write to disk checked it stayed under the root the binary poses at.
//! Three tests below hand the binary an id built to leave the root one of
//! the three ways a path can: an absolute id, a `..` component, and (on
//! Unix, where a test can make one without elevated privilege) an existing
//! symlink. Each is refused before anything is written — a claim measured
//! by listing the filesystem afterwards, not assumed from the exit code
//! alone.
//!
//! **`a_catalogue_that_cannot_be_read_is_an_impossible_request`** measures a
//! different closed gap: `install` used to answer `RUNTIME_FAILURE` (`1`)
//! for a `<catalog>` path that does not exist, telling a caller to retry a
//! command that would fail identically every time. It now answers
//! `REQUEST_CANNOT_BE_SATISFIED` (`2`), the code this binary's own contract
//! reserves for a request fixed only by asking something different.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A working root this file owns, removed once the test that built it is
/// done with it.
struct Scratch {
    base: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Self {
        let base =
            std::env::temp_dir().join(format!("rigger-cli-install-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("root")).expect("create the working root");
        Self { base }
    }

    fn root(&self) -> PathBuf {
        self.base.join("root")
    }

    /// Writes a one-entry, `format = 1` catalogue naming `id`, and returns
    /// its path — the one shape `crates/rigger-cli/src/descriptor.rs` reads.
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

/// The names directly under `root`, sorted — empty is the claim every
/// refusal test below makes: nothing was written for a refused id, not even
/// `.rigger` itself.
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

/// Runs `install` against `scratch` with a one-entry catalogue naming `id`,
/// and asserts the observables every refusal in this file shares: exit code
/// `2`, silence on stdout, and a stderr mentioning `needle`. Returns the
/// output so a caller can go on to assert what a refusal like this one must
/// leave on the filesystem, which differs per test.
fn assert_refused(scratch: &Scratch, id: &str, needle: &str) -> Output {
    let catalogue = scratch.catalogue(id);
    let output = run(
        &scratch.root(),
        &["install", catalogue.to_str().unwrap(), id],
    );

    assert_eq!(
        output.status.code(),
        Some(2),
        "exit code for id `{id}`, stdout: {}, stderr: {}",
        stdout_of(&output),
        stderr_of(&output)
    );
    assert_eq!(
        stdout_of(&output),
        "",
        "a refused install printed on stdout for id `{id}`"
    );
    assert!(
        stderr_of(&output).contains(needle),
        "stderr for id `{id}` does not mention `{needle}`: {}",
        stderr_of(&output)
    );
    output
}

#[test]
fn an_id_that_is_an_absolute_path_is_refused_and_nothing_is_written() {
    let scratch = Scratch::new("absolute");
    let id = "/tmp/rigger-cli-test-should-not-be-written";

    assert_refused(&scratch, id, "absolute");

    assert_eq!(
        top_level(&scratch.root()),
        Vec::<String>::new(),
        "an absolute id left something behind in the root"
    );
    assert!(
        !Path::new(id).exists(),
        "an absolute id actually posed a file at the absolute path it named"
    );
}

#[test]
fn an_id_carrying_a_parent_directory_component_is_refused_and_nothing_is_written() {
    let scratch = Scratch::new("traversal");
    let id = "../rigger-cli-test-should-not-be-written";

    assert_refused(&scratch, id, "..");

    assert_eq!(
        top_level(&scratch.root()),
        Vec::<String>::new(),
        "a `..` id left something behind in the root"
    );
    assert!(
        !scratch
            .base
            .join("rigger-cli-test-should-not-be-written")
            .exists(),
        "a `..` id actually posed a file one level above the root"
    );
}

#[cfg(unix)]
#[test]
fn an_id_resolving_through_a_symlink_that_leaves_the_root_is_refused_and_nothing_is_written() {
    let scratch = Scratch::new("symlink");
    let root = scratch.root();
    let outside = scratch.base.join("outside");
    std::fs::create_dir_all(&outside).expect("create the external target");
    std::os::unix::fs::symlink(&outside, root.join("escape")).expect("create the escaping symlink");
    let id = "escape/rigger-cli-test-should-not-be-written";

    assert_refused(&scratch, id, "symlink");

    assert_eq!(
        top_level(&outside),
        Vec::<String>::new(),
        "an id resolving through an escaping symlink wrote outside the root"
    );
    assert_eq!(
        top_level(&root),
        vec!["escape".to_string()],
        "the pre-existing symlink itself should be untouched, and nothing else should appear"
    );
}

#[test]
fn a_catalogue_that_cannot_be_read_is_an_impossible_request() {
    let scratch = Scratch::new("catalogue-illisible");
    let root = scratch.root();
    let missing_catalogue = scratch.base.join("does-not-exist.toml");

    let output = run(
        &root,
        &[
            "install",
            missing_catalogue.to_str().unwrap(),
            "review-checklist",
        ],
    );

    assert_eq!(
        output.status.code(),
        Some(2),
        "exit code for a catalogue that cannot be read, stdout: {}, stderr: {}",
        stdout_of(&output),
        stderr_of(&output)
    );
    assert_eq!(
        stdout_of(&output),
        "",
        "a refused install printed on stdout"
    );
    assert_eq!(
        top_level(&root),
        Vec::<String>::new(),
        "a catalogue that cannot be read left something behind in the root"
    );
}
