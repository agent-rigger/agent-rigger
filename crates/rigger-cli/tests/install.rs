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
//!
//! **The tests from `installing_a_hook_poses_the_bytes_of_the_real_artefact`
//! onward measure ADR-0048 and ADR-0049** — that what is posed is the
//! artefact `crates/rigger-cli/src/source.rs` resolves and reads off disk,
//! whether that artefact is one file, a whole directory planted as one tree,
//! or several files a `path` array names planted as the small tree they
//! form.
//!
//! **The last two tests measure the two answers `install` owes when the
//! address it is about to pose to is already occupied.** When the registry
//! itself names this same catalogue entry at that address, this product
//! posed what is occupying it, and reinstalling it is a request that cannot
//! be satisfied — not damage, and not a reason to retry. When nothing in the
//! registry says so, the file is left exactly as it was found, under the
//! same refusal and the same exit code as before.

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

    /// Writes a one-entry, `format = 1` catalogue whose entry carries
    /// `nature`, plus whatever literal TOML lines `extra` holds — a `path =`
    /// override, or nothing — appended right after `nature`. The fuller
    /// shape the ADR-0048 tests below need, `catalogue` above being fixed to
    /// `nature = "hook"` and no override.
    fn catalogue_with(&self, id: &str, nature: &str, extra: &str) -> PathBuf {
        let path = self.base.join("catalog.toml");
        std::fs::write(
            &path,
            format!(
                "format = 1\n\n[meta]\nname = \"acme\"\n\n[[entries]]\nkind = \"artifact\"\nid = \
                 \"{id}\"\nnature = \"{nature}\"\n{extra}"
            ),
        )
        .expect("write the catalogue");
        path
    }

    /// Writes `contents` at `relative`, under this scratch's own base — the
    /// catalogue root ADR-0048 resolves an artefact source against, since
    /// `catalogue` and `catalogue_with` both write `catalog.toml` directly
    /// under it.
    fn write_source(&self, relative: &str, contents: &str) {
        let path = self.base.join(relative);
        std::fs::create_dir_all(path.parent().expect("a source path carries a parent"))
            .expect("create the artefact's directory");
        std::fs::write(&path, contents).expect("write the artefact");
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

#[test]
fn installing_a_hook_poses_the_bytes_of_the_real_artefact() {
    let scratch = Scratch::new("real-artefact");
    let root = scratch.root();
    scratch.write_source("hooks/guard-command.ts", "export const guarded = true;\n");
    let catalogue = scratch.catalogue_with("hook:guard-command", "hook", "");

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "hook:guard-command"],
    );

    assert_eq!(
        output.status.code(),
        Some(0),
        "exit code, stderr: {}",
        stderr_of(&output)
    );
    let posed = std::fs::read_to_string(root.join("hook-guard-command"))
        .expect("the pose should have written `hook-guard-command` at the root");
    assert_eq!(
        posed, "export const guarded = true;\n",
        "install posed something other than the bytes of `hooks/guard-command.ts`"
    );
}

#[test]
fn a_single_string_path_override_poses_the_file_it_names() {
    let scratch = Scratch::new("override-single");
    let root = scratch.root();
    scratch.write_source("contexts/AGENTS.md", "# Context\n");
    let catalogue = scratch.catalogue_with(
        "context:claude",
        "context",
        "path = \"contexts/AGENTS.md\"\n",
    );

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "context:claude"],
    );

    assert_eq!(
        output.status.code(),
        Some(0),
        "exit code, stderr: {}",
        stderr_of(&output)
    );
    let posed = std::fs::read_to_string(root.join("context-claude"))
        .expect("the pose should have written `context-claude` at the root");
    assert_eq!(
        posed, "# Context\n",
        "install did not pose the file named by the `path` override"
    );
}

#[test]
fn an_unknown_nature_is_refused_and_nothing_is_written() {
    let scratch = Scratch::new("unknown-nature");
    let root = scratch.root();
    let catalogue = scratch.catalogue_with("plugin:acme", "plugin", "");

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "plugin:acme"],
    );

    assert_eq!(
        output.status.code(),
        Some(2),
        "exit code, stdout: {}, stderr: {}",
        stdout_of(&output),
        stderr_of(&output)
    );
    assert!(
        stderr_of(&output).contains("nature"),
        "stderr does not name the unknown nature: {}",
        stderr_of(&output)
    );
    assert_eq!(
        top_level(&root),
        Vec::<String>::new(),
        "an unknown nature left something behind in the root"
    );
}

#[test]
fn an_artefact_absent_on_disk_is_refused_and_nothing_is_written() {
    let scratch = Scratch::new("artefact-absent");
    let root = scratch.root();
    // No `hooks/guard-command.ts` is ever written for this scratch — the
    // nature resolves cleanly, and the file it names is the thing missing.
    let catalogue = scratch.catalogue_with("hook:guard-command", "hook", "");

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "hook:guard-command"],
    );

    assert_eq!(
        output.status.code(),
        Some(2),
        "exit code, stdout: {}, stderr: {}",
        stdout_of(&output),
        stderr_of(&output)
    );
    assert!(
        stderr_of(&output).contains("no artefact"),
        "stderr does not report the missing artefact: {}",
        stderr_of(&output)
    );
    assert_eq!(
        top_level(&root),
        Vec::<String>::new(),
        "an absent artefact left something behind in the root"
    );
}

#[test]
fn a_directory_disposition_poses_the_whole_tree_as_one_thing() {
    let scratch = Scratch::new("directory-disposition");
    let root = scratch.root();
    scratch.write_source("skills/spec-workflow/SKILL.md", "# Spec workflow\n");
    scratch.write_source("skills/spec-workflow/references/notes.md", "notes\n");
    let catalogue = scratch.catalogue_with("skill:spec-workflow", "skill", "");

    let output = run(
        &root,
        &[
            "install",
            catalogue.to_str().unwrap(),
            "skill:spec-workflow",
        ],
    );

    assert_eq!(
        output.status.code(),
        Some(0),
        "exit code, stderr: {}",
        stderr_of(&output)
    );
    let planted = root.join("skill-spec-workflow");
    assert!(
        planted.is_dir(),
        "install should have planted a directory at `skill-spec-workflow`"
    );
    assert_eq!(
        std::fs::read_to_string(planted.join("SKILL.md")).expect("SKILL.md should be there"),
        "# Spec workflow\n",
        "the top-level file of the planted tree does not carry the source bytes"
    );
    assert_eq!(
        std::fs::read_to_string(planted.join("references/notes.md"))
            .expect("references/notes.md should be there"),
        "notes\n",
        "a file nested under the planted tree does not carry the source bytes"
    );
}

#[test]
fn a_path_array_naming_more_than_one_file_plants_them_as_one_tree() {
    let scratch = Scratch::new("multi-file-override");
    let root = scratch.root();
    scratch.write_source("guardrails/allow.json", "{}\n");
    scratch.write_source("guardrails/deny.json", "{\"deny\":true}\n");
    let catalogue = scratch.catalogue_with(
        "guardrail:claude",
        "guardrail",
        "path = [\"guardrails/allow.json\", \"guardrails/deny.json\"]\n",
    );

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "guardrail:claude"],
    );

    assert_eq!(
        output.status.code(),
        Some(0),
        "exit code, stderr: {}",
        stderr_of(&output)
    );
    let planted = root.join("guardrail-claude");
    assert!(
        planted.is_dir(),
        "install should have planted a directory at `guardrail-claude`"
    );
    assert_eq!(
        std::fs::read_to_string(planted.join("allow.json")).expect("allow.json should be there"),
        "{}\n",
        "the tree does not carry the bytes of the first named file"
    );
    assert_eq!(
        std::fs::read_to_string(planted.join("deny.json")).expect("deny.json should be there"),
        "{\"deny\":true}\n",
        "the tree does not carry the bytes of the second named file"
    );
}

#[test]
fn an_entry_declaring_a_directory_disposition_poses_a_tree_its_nature_would_not_have_named() {
    let scratch = Scratch::new("disposition-override");
    let root = scratch.root();
    scratch.write_source(
        "hooks/guard-command/main.ts",
        "export const guarded = true;\n",
    );
    let catalogue = scratch.catalogue_with(
        "hook:guard-command",
        "hook",
        "disposition = \"directory\"\n",
    );

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "hook:guard-command"],
    );

    assert_eq!(
        output.status.code(),
        Some(0),
        "exit code, stderr: {}",
        stderr_of(&output)
    );
    let planted = root.join("hook-guard-command");
    assert!(
        planted.is_dir(),
        "a declared `disposition = \"directory\"` should have planted a directory, not the \
         `.ts` file the `hook` nature would have named by default"
    );
    assert_eq!(
        std::fs::read_to_string(planted.join("main.ts")).expect("main.ts should be there"),
        "export const guarded = true;\n",
        "the planted tree does not carry the source bytes"
    );
}

#[test]
fn an_invalid_disposition_is_refused_and_nothing_is_written() {
    let scratch = Scratch::new("disposition-invalid");
    let root = scratch.root();
    scratch.write_source("hooks/guard-command.ts", "export const guarded = true;\n");
    let catalogue =
        scratch.catalogue_with("hook:guard-command", "hook", "disposition = \"folder\"\n");

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "hook:guard-command"],
    );

    assert_eq!(
        output.status.code(),
        Some(2),
        "exit code, stdout: {}, stderr: {}",
        stdout_of(&output),
        stderr_of(&output)
    );
    assert!(
        stderr_of(&output).contains("disposition"),
        "stderr does not name the invalid `disposition` field: {}",
        stderr_of(&output)
    );
    assert_eq!(
        top_level(&root),
        Vec::<String>::new(),
        "an invalid `disposition` left something behind in the root"
    );
}

#[test]
fn reinstalling_an_entry_the_registry_already_recorded_is_an_impossible_request() {
    let scratch = Scratch::new("reinstall-recorded");
    let root = scratch.root();
    scratch.write_source("hooks/guard-command.ts", "export const guarded = true;\n");
    let catalogue = scratch.catalogue_with("hook:guard-command", "hook", "");

    let first = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "hook:guard-command"],
    );
    assert_eq!(
        first.status.code(),
        Some(0),
        "the first install should have succeeded, stderr: {}",
        stderr_of(&first)
    );

    let second = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "hook:guard-command"],
    );

    assert_eq!(
        second.status.code(),
        Some(2),
        "reinstalling what the registry already recorded should be a request that cannot be \
         satisfied, not a runtime failure — nothing on the machine is broken, stdout: {}, \
         stderr: {}",
        stdout_of(&second),
        stderr_of(&second)
    );
    assert_eq!(
        stdout_of(&second),
        "",
        "a refused reinstall printed on stdout"
    );
    assert!(
        stderr_of(&second).contains("already"),
        "stderr does not say the entry is already installed: {}",
        stderr_of(&second)
    );
    assert!(
        stderr_of(&second).contains("acme"),
        "stderr does not name the catalogue that already posed it: {}",
        stderr_of(&second)
    );

    let posed = std::fs::read_to_string(root.join("hook-guard-command"))
        .expect("what the first install posed should still be there");
    assert_eq!(
        posed, "export const guarded = true;\n",
        "a refused reinstall touched what the first install had posed"
    );
}

#[test]
fn installing_over_a_file_the_registry_does_not_know_about_is_a_runtime_failure_and_is_left_alone()
{
    let scratch = Scratch::new("occupied-unrecorded");
    let root = scratch.root();
    scratch.write_source("hooks/guard-command.ts", "export const guarded = true;\n");
    let catalogue = scratch.catalogue_with("hook:guard-command", "hook", "");
    std::fs::write(
        root.join("hook-guard-command"),
        "not written by rigger-cli\n",
    )
    .expect("write a file this product never posed");

    let output = run(
        &root,
        &["install", catalogue.to_str().unwrap(), "hook:guard-command"],
    );

    assert_eq!(
        output.status.code(),
        Some(1),
        "an address occupied by something the registry does not know about should still be a \
         runtime failure, stdout: {}, stderr: {}",
        stdout_of(&output),
        stderr_of(&output)
    );
    assert_eq!(
        stdout_of(&output),
        "",
        "a refused install printed on stdout"
    );
    assert!(
        stderr_of(&output).contains("did not put it there"),
        "stderr does not carry the refusal owed when the registry cannot vouch for what is \
         there: {}",
        stderr_of(&output)
    );

    let untouched = std::fs::read_to_string(root.join("hook-guard-command"))
        .expect("the pre-existing file should still be there");
    assert_eq!(
        untouched, "not written by rigger-cli\n",
        "install overwrote a file it never put there"
    );
}
