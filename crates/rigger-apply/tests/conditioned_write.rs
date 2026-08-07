//! Writing an owned document, in scenarios.
//!
//! Tests prefixed with an identifier carry the name of the scenario of
//! `docs/specs/socle-neuf/requirements.md` they realise. Those of C1 and C2 that
//! live here are the ones whose observation bears on the **disk** — "the
//! document on disk is the one from before" is measured nowhere else.
//!
//! Each test works in its own directory: the temporary of a write lives next to
//! its target, so two tests sharing a directory would see each other.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{capture, merge_into_file, stage, ApplyError, TxnError};
use rigger_grammar::{
    Applied, Edit, Grammar, GrammarError, GrammarRole, Inverse, Jsonc, MergeError, Probe,
    Resolution, SemanticValue, Toml, Value,
};

/// A settings document as a user holds it.
const SETTINGS: &str = concat!(
    "{\n",
    "\t\"model\": \"acme/model-small\", // personal — do not touch\n",
    "\t\"instructions\": [\"AGENTS.md\", \"docs/rules.md\"]\n",
    "}\n",
);

/// An empty working directory, private to this test.
fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-apply-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create the working directory");
    path
}

/// The files present in a directory, sorted — enough to observe that no
/// temporary is left behind.
fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read the directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn document(dir: &Path, content: &str) -> PathBuf {
    let path = dir.join("settings.json");
    fs::write(&path, content).expect("write the owned document");
    path
}

fn fragment() -> Edit {
    Edit::values(&["instructions"], ["docs/pose.md"])
}

#[test]
fn c8_an_undisturbed_document_receives_the_pose_and_its_trace_undoes_it() {
    // GIVEN a document nobody touches during the operation.
    let dir = directory("nominal");
    let target = document(&dir, SETTINGS);

    // WHEN the pose runs.
    let trace = merge_into_file::<Jsonc>(&target, &fragment()).expect("the pose must succeed");

    // THEN it succeeds, and the guard produced neither a warning nor a detour:
    // the document carries what the trace records, and nothing else.
    let after = fs::read_to_string(&target).expect("read back");
    assert!(after.contains("docs/pose.md"));
    assert!(after.contains("// personal — do not touch"));
    assert_eq!(
        Jsonc::invert(&after, &trace).expect("the inverse must apply"),
        SETTINGS,
        "the trace does not return the document from before"
    );
    assert_eq!(files(&dir), vec!["settings.json".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: no scenario of C8 names the symbolic link, and yet the
/// layout is that of a dotfiles repository — the settings file in the home
/// directory **is** a link to the versioned document.
///
/// Renaming onto the link replaces it with an ordinary file: the link disappears
/// without a trace, the real document never receives the pose, and the call
/// reports success. Nothing in the registry would allow restoring it, since the
/// inverse of a pose undoes a write and never a destroyed link.
#[cfg(unix)]
#[test]
fn guard_a_target_that_is_a_symlink_receives_the_pose_without_losing_the_link() {
    let dir = directory("symlink");
    let repository = dir.join("dotfiles");
    let home = dir.join("home");
    fs::create_dir_all(&repository).expect("create the repository");
    fs::create_dir_all(&home).expect("create the home directory");
    let real = repository.join("settings.json");
    fs::write(&real, SETTINGS).expect("write the versioned document");
    let link = home.join("settings.json");
    std::os::unix::fs::symlink(&real, &link).expect("create the link");

    // The temporary lives next to the versioned document, and not next to the
    // link: a rename is atomic only within one filesystem, and nothing says the
    // repository and the home directory live on the same one.
    let staged = stage(&link, "{}\n").expect("the temporary must be written");
    assert_eq!(
        staged.temporary_path().parent(),
        Some(repository.as_path()),
        "the temporary does not live in the directory of the designated document"
    );
    drop(staged);

    let trace = merge_into_file::<Jsonc>(&link, &fragment()).expect("the pose must succeed");

    // The link is still a link.
    assert!(
        fs::symlink_metadata(&link)
            .expect("the link must exist")
            .file_type()
            .is_symlink(),
        "the link was replaced by an ordinary file"
    );

    // And it is the versioned document that received the pose.
    let after = fs::read_to_string(&real).expect("read the versioned document back");
    assert!(
        after.contains("docs/pose.md"),
        "the real document did not receive the pose: {after}"
    );
    assert_eq!(
        Jsonc::invert(&after, &trace).expect("the inverse must apply"),
        SETTINGS,
        "the trace does not return the document from before"
    );

    // No temporary is left behind, on either side.
    assert_eq!(files(&home), vec!["settings.json".to_string()]);
    assert_eq!(files(&repository), vec!["settings.json".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn c8_a_document_changed_between_the_computation_and_the_write_aborts() {
    // GIVEN a plan computed on a document whose fingerprint was taken.
    let dir = directory("third-party");
    let target = document(&dir, SETTINGS);
    let capture = capture(&target).expect("the capture must succeed");

    // AND that document rewritten by a third party before the write.
    const BY_THE_THIRD_PARTY: &str = "{\n\t\"model\": \"acme/model-large\"\n}\n";
    fs::write(&target, BY_THE_THIRD_PARTY).expect("rewrite by a third party");

    // WHEN the write runs.
    let staged = stage(&target, "{\n\t\"pose\": true\n}\n").expect("the temporary must be written");
    let failure = staged
        .commit(capture.fingerprint())
        .expect_err("the write applied on a document that had changed");

    // THEN it fails while naming the file.
    assert!(
        matches!(&failure, TxnError::Changed { path } if path == &target),
        "the failure does not name the file: {failure}"
    );
    assert!(failure.to_string().contains("settings.json"));

    // AND the document carries what the third party wrote there, intact.
    assert_eq!(
        fs::read_to_string(&target).expect("read back"),
        BY_THE_THIRD_PARTY
    );

    // AND no temporary file is left behind.
    assert_eq!(files(&dir), vec!["settings.json".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn c8_the_write_is_atomic() {
    // GIVEN a write stopped between writing the temporary and the rename — that
    // is, the instant this split makes observable.
    let dir = directory("atomic");
    let target = document(&dir, SETTINGS);
    let capture = capture(&target).expect("the capture must succeed");
    const AFTER: &str = "{\n\t\"pose\": true\n}\n";
    let staged = stage(&target, AFTER).expect("the temporary must be written");

    // WHEN the disk is inspected.
    // THEN the owned document is the one from before, whole, and the content
    // from after is already written whole elsewhere: there exists no instant at
    // which the target carries an intermediate state.
    assert_eq!(fs::read_to_string(&target).expect("read back"), SETTINGS);
    assert_eq!(
        fs::read_to_string(staged.temporary_path()).expect("read the temporary back"),
        AFTER
    );

    // And after the rename, it carries the one from after, whole.
    staged.commit(capture.fingerprint()).expect("the rename");
    assert_eq!(fs::read_to_string(&target).expect("read back"), AFTER);
    assert_eq!(files(&dir), vec!["settings.json".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn c8_the_temporary_lives_in_the_same_directory() {
    // GIVEN a write in progress.
    let dir = directory("same-directory");
    let target = document(&dir, SETTINGS);
    let staged = stage(&target, "{}\n").expect("the temporary must be written");

    // WHEN the disk is inspected.
    // THEN the temporary file is in the directory of the target document — a
    // rename being atomic only within one filesystem.
    assert_eq!(
        staged.temporary_path().parent(),
        target.parent(),
        "the temporary does not live in the directory of the target document"
    );
    assert!(staged.temporary_path().exists());
    assert_ne!(staged.temporary_path(), target);

    // And it disappears with the abandoned transaction: a temporary left behind
    // is a fragment of an owned document lying around.
    let temporary = staged.temporary_path().to_path_buf();
    drop(staged);
    assert!(!temporary.exists());
    assert_eq!(files(&dir), vec!["settings.json".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// A grammar that rewrites the document on disk **during the computation** —
/// after the capture read it, before the rename replaces it. It stands in for
/// the only concurrent writer the product can neither exclude nor foresee: the
/// host rewriting its own settings file, against which an inter-process lock
/// can do nothing.
///
/// Everything else is JSONC's, so the merge itself succeeds: a refusal coming
/// from the merge would say nothing about what the write is conditioned on.
struct HostRewritesDuringTheComputation;

thread_local! {
    /// The document the grammar above rewrites, and what the host writes there.
    /// Taken on the first call, so that the several applications one merge
    /// performs — the admission gate applies the grammar to its probe before
    /// the edit runs — rewrite the document exactly once.
    static PENDING_REWRITE: RefCell<Option<(PathBuf, &'static str)>> = const { RefCell::new(None) };
}

impl Grammar for HostRewritesDuringTheComputation {
    const NAME: &'static str = "host-rewrites";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
    const PROBE: Probe = Jsonc::PROBE;

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Jsonc::round_trip(source)
    }

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        Jsonc::find_string_in_list(source, path, value)
    }

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        if let Some((path, by_the_host)) = PENDING_REWRITE.with(|slot| slot.borrow_mut().take()) {
            fs::write(&path, by_the_host).expect("the host rewrites its own settings file");
        }
        Jsonc::apply(source, edit)
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        Jsonc::invert(source, inverse)
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Jsonc::values(source)
    }
}

#[test]
fn c8_the_write_is_conditioned_on_the_capture_and_never_on_a_later_read() {
    // GIVEN a document the host rewrites between the capture and the write —
    // the one instant the guard exists for, and the only one at which "derived
    // from the capture" and "read a second time" give different answers.
    let dir = directory("fingerprint");
    let target = document(&dir, SETTINGS);
    const BY_THE_HOST: &str = "{\n\t\"model\": \"acme/model-large\"\n}\n";
    PENDING_REWRITE.with(|slot| *slot.borrow_mut() = Some((target.clone(), BY_THE_HOST)));

    // WHEN the pose runs, through the whole chain rather than through a capture
    // the test itself holds: what is measured here is what the write conditions
    // itself on, and that wiring lives in the chain.
    let failure = merge_into_file::<HostRewritesDuringTheComputation>(&target, &fragment())
        .expect_err("the write landed on a document that had changed under it");

    // THEN it fails while naming the file, because the fingerprint it compares
    // against is the one the capture read. A fingerprint taken from a second
    // read would carry what the host has just written, would match, and the
    // pose would land on top of it — success reported, the host's write gone,
    // and no trace of either.
    assert!(
        matches!(&failure, ApplyError::Txn(TxnError::Changed { path }) if path == &target),
        "the write did not condition itself on what the capture read: {failure}"
    );
    assert!(failure.to_string().contains("settings.json"));

    // AND the document carries what the host wrote, intact.
    assert_eq!(
        fs::read_to_string(&target).expect("read back"),
        BY_THE_HOST,
        "the pose was applied on top of what the host wrote"
    );

    // AND nothing was left alongside it.
    assert_eq!(files(&dir), vec!["settings.json".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn c1_a_grammar_that_does_not_preserve_aborts_before_replacing_the_document() {
    // GIVEN an owned document and a grammar whose implementation does not return
    // the bytes outside the trace.
    let dir = directory("non-preserving");
    let hard_case = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../rigger-grammar/tests/corpus-limits/config-crlf.toml");
    let before = fs::read(&hard_case).expect("read the document of the hard case");
    let target = dir.join("config.toml");
    fs::write(&target, &before).expect("write the owned document");

    // WHEN a pose goes through it.
    let failure = merge_into_file::<Toml>(&target, &fragment())
        .expect_err("a grammar that does not preserve wrote into an owned document");

    // THEN the transaction aborts before the document is replaced, and the
    // message names the grammar and what was not preserved.
    let message = failure.to_string();
    for expected in ["toml", "merge", "line endings"] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }
    assert!(matches!(
        failure,
        ApplyError::Merge(MergeError::NotAdmitted(_))
    ));

    // AND the document on disk is the one from before, and nothing was written
    // alongside it.
    assert_eq!(fs::read(&target).expect("read back"), before);
    assert_eq!(files(&dir), vec!["config.toml".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// A grammar that writes **through text** instead of writing through the
/// structure, and that therefore makes a value the user had put there leave the
/// document. This is the mode the post-condition exists to catch, reproduced in
/// its most direct form.
///
/// Everything else is JSONC's, the probe included: this grammar must **pass the
/// admission gate**, failing which the refusal measured below would come from
/// admission and would say nothing about the post-condition. The probe does not
/// carry the destroyed value, so the destruction is invisible there — and that is
/// exactly why an observation on the **output** is the only one that says what we
/// did.
struct DestructiveGrammar;

impl Grammar for DestructiveGrammar {
    const NAME: &'static str = "destructive";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
    const PROBE: Probe = Jsonc::PROBE;

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Jsonc::round_trip(source)
    }

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        Jsonc::find_string_in_list(source, path, value)
    }

    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        let applied = Jsonc::apply(source, edit)?;
        Ok(Applied {
            rendered: applied.rendered.replace("\"docs/rules.md\", ", ""),
            inverse: applied.inverse,
        })
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        Jsonc::invert(source, inverse)
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Jsonc::values(source)
    }
}

#[test]
fn c2_the_post_condition_compares_semantic_values() {
    // GIVEN a pose whose write makes a pre-existing value disappear.
    let dir = directory("post-condition");
    let target = document(&dir, SETTINGS);

    // WHEN the post-condition runs.
    let failure = merge_into_file::<DestructiveGrammar>(&target, &fragment())
        .expect_err("a value of the user left the document without anything going red");

    // THEN it fails while naming the vanished value and its path.
    let message = failure.to_string();
    for expected in ["docs/rules.md", "instructions"] {
        assert!(
            message.contains(expected),
            "the failure does not name \"{expected}\": {message}"
        );
    }
    match &failure {
        ApplyError::Merge(MergeError::ValuesLost { lost, .. }) => {
            assert_eq!(lost.len(), 1, "{lost:?}");
            assert_eq!(lost[0].path(), "instructions");
            assert_eq!(lost[0].value(), &Value::text("docs/rules.md"));
        }
        other => panic!("the failure does not come from the post-condition: {other:?}"),
    }

    // AND the transaction aborts: the document on disk is the one from before.
    assert_eq!(fs::read_to_string(&target).expect("read back"), SETTINGS);
    assert_eq!(files(&dir), vec!["settings.json".to_string()]);
    fs::remove_dir_all(&dir).expect("clean up");
}
