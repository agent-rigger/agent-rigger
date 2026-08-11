//! The atomic **and conditional** write of an owned document.
//!
//! Three gestures, in this order, and each one pays for a named failure.
//!
//! **A temporary in the same directory as the target.** A rename is atomic only
//! within one filesystem; writing the temporary into the system's temporary
//! directory would make the rename non-atomic on the machines where the home
//! directory and the repository live on different volumes — that is, exactly
//! where testing would not have shown it.
//!
//! **The temporary is written under the permissions of the document it will
//! replace.** The rename swaps the inodes: a temporary created from nothing
//! carries the process umask, and the document would come out of the pose under
//! that mode instead of its own. See `write_alongside`.
//!
//! **A re-check of the fingerprint just before the rename.** It bears on what
//! the **capture** read, never on a second read — a second read would reopen the
//! window this is meant to close.
//!
//! **A rename.** The owned document is therefore, at every observable instant,
//! either the one from before or the one from after.
//!
//! **The rename bears on the document, never on the link that designates it.** A
//! settings file in the home directory is commonly a link into a versioned
//! configuration repository — that is the very purpose of that kind of
//! repository. Renaming onto the link would replace it with an ordinary file:
//! the link would disappear without a trace, the real document would never
//! receive the pose, and the call would report success. The product therefore
//! follows the link down to the document, and it is next to **that one** that
//! the temporary is written — without which the rename would cross a filesystem
//! and stop being atomic.
//!
//! **What the fingerprint is here, and why.** The content read at the moment it
//! is computed, itself. The comparison is then exact and cannot be mistaken,
//! where a digest trades that certainty for memory — an arbitration that would
//! hold for documents of unknown size, and that does not hold for a settings
//! file the capture has just loaded whole anyway. The day it does hold, this
//! type is the only place to change.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rigger_grammar::{merge, Edit, Grammar, Inverse, MergeError};

/// The state of a document at the moment the plan was computed.
#[derive(Clone, PartialEq, Eq)]
pub struct Fingerprint(Vec<u8>);

impl Fingerprint {
    /// The fingerprint of these bytes.
    pub fn of(bytes: &[u8]) -> Self {
        Self(bytes.to_vec())
    }
}

impl fmt::Debug for Fingerprint {
    /// Renders the size only: the content of an owned document carries tokens,
    /// and a diagnostic message travels further than one thinks.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Fingerprint({} bytes)", self.0.len())
    }
}

/// What the capture read: the document, and its fingerprint, from **one single**
/// read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    content: String,
    fingerprint: Fingerprint,
}

impl Capture {
    /// The document as it stood at the moment of the computation.
    pub fn content(&self) -> &str {
        &self.content
    }

    /// Its fingerprint, derived from what that one read returned.
    pub fn fingerprint(&self) -> &Fingerprint {
        &self.fingerprint
    }
}

/// Why a write did not happen. None of these variants leaves a write partially
/// applied.
#[derive(Debug)]
pub enum TxnError {
    /// The document could not be read.
    Read {
        /// The file concerned.
        path: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
    /// The temporary or the rename failed.
    Write {
        /// The file concerned.
        path: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
    /// The document changed between the computation and the write. That is a
    /// failure, and never an applied write.
    Changed {
        /// The file concerned.
        path: PathBuf,
    },
    /// The document is not UTF-8, so no grammar served reads it. Refused rather
    /// than rewritten with replacement bytes, which would silently destroy what
    /// they replace.
    NotUtf8 {
        /// The file concerned.
        path: PathBuf,
    },
}

impl fmt::Display for TxnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, detail } => {
                write!(f, "{}: cannot be read — {detail}", path.display())
            }
            Self::Write { path, detail } => {
                write!(f, "{}: cannot be written — {detail}", path.display())
            }
            Self::Changed { path } => write!(
                f,
                "{}: the document changed between the computation and the write — nothing was \
                 written",
                path.display()
            ),
            Self::NotUtf8 { path } => write!(
                f,
                "{}: the document is not UTF-8 — the product refuses rather than replace the bytes \
                 it does not know how to read",
                path.display()
            ),
        }
    }
}

impl std::error::Error for TxnError {}

/// Reads an owned document and returns its content **and** its fingerprint, from
/// one single read. It is on that capture that the write is conditioned.
pub fn capture(path: &Path) -> Result<Capture, TxnError> {
    let bytes = fs::read(path).map_err(|detail| TxnError::Read {
        path: path.to_path_buf(),
        detail,
    })?;
    let content = String::from_utf8(bytes).map_err(|_| TxnError::NotUtf8 {
        path: path.to_path_buf(),
    })?;
    let fingerprint = Fingerprint::of(content.as_bytes());
    Ok(Capture {
        content,
        fingerprint,
    })
}

/// A content already written whole next to its target, waiting for nothing but
/// the re-check and the rename.
///
/// Until it is committed, it **removes itself**: an abandoned temporary is a
/// fragment of an owned document left lying in its owner's directory, and
/// abandonment also happens through an error higher up, or through a panic.
#[derive(Debug)]
#[must_use = "a staged content is written by `commit` and by nothing else; dropping it takes the \
              temporary away and leaves the document as it was"]
pub struct Staged {
    /// The path as the caller gave it. It is the one refusals name: it is the
    /// one its owner recognises.
    target: PathBuf,
    /// The document the rename replaces — the target, or what it points to when
    /// it is a symbolic link.
    document: PathBuf,
    temporary: Option<PathBuf>,
}

impl Staged {
    /// The path of the temporary, in the directory of the target.
    pub fn temporary_path(&self) -> &Path {
        self.temporary
            .as_deref()
            .expect("a committed temporary can no longer be queried")
    }

    /// Re-checks the fingerprint, then renames. Any divergence is a failure that
    /// names the file, and never an applied write.
    pub fn commit(mut self, expected: &Fingerprint) -> Result<(), TxnError> {
        let temporary = self
            .temporary
            .take()
            .expect("a temporary is committed only once");

        let current = fs::read(&self.document).map_err(|detail| TxnError::Read {
            path: self.target.clone(),
            detail,
        });
        let current = match current {
            Ok(current) => current,
            Err(err) => {
                let _ = fs::remove_file(&temporary);
                return Err(err);
            }
        };
        if Fingerprint::of(&current) != *expected {
            let _ = fs::remove_file(&temporary);
            return Err(TxnError::Changed {
                path: self.target.clone(),
            });
        }

        fs::rename(&temporary, &self.document).map_err(|detail| {
            let _ = fs::remove_file(&temporary);
            TxnError::Write {
                path: self.target.clone(),
                detail,
            }
        })
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(temporary) = self.temporary.take() {
            let _ = fs::remove_file(temporary);
        }
    }
}

/// Writes `contents` into a temporary of the **directory of the document**,
/// touching neither the document nor `target`. When `target` is a symbolic link,
/// the document is what it points to.
///
/// **Dropping what this returns writes nothing**, and the [`Drop`] that makes
/// that safe is what makes it quiet: the temporary goes away, the document is
/// left as it was, and a forgotten write looks exactly like a write that was
/// never asked for. The attribute on [`Staged`] is what the compiler says it
/// with:
///
/// ```compile_fail
/// #![deny(unused_must_use)]
/// use std::path::Path;
/// use rigger_apply::stage;
///
/// stage(Path::new("settings.json"), "AFTER").unwrap();
/// ```
///
/// Its twin, which differs by the one gesture and compiles — without it the
/// refusal above would be indistinguishable from a typo:
///
/// ```no_run
/// use std::path::Path;
/// use rigger_apply::{stage, Fingerprint};
///
/// let staged = stage(Path::new("settings.json"), "AFTER").unwrap();
/// staged.commit(&Fingerprint::of(b"BEFORE")).unwrap();
/// ```
///
/// **What the attribute closes is one of three forms, and only one.**
/// `let _ = stage(..)?;` and `let _staged = stage(..)?;` stay silent under it,
/// and are meant to: both are refusals somebody wrote down, and a reader sees
/// them. The bound-and-unused form is already covered by `unused_variables`
/// under `-D warnings`. What is left, and what the attribute is for, is the
/// form where nothing is written at all.
pub fn stage(target: &Path, contents: &str) -> Result<Staged, TxnError> {
    let document = designated_document(target)?;
    let temporary = temporary_path(&document);
    write_alongside(&document, &temporary, contents).map_err(|detail| TxnError::Write {
        path: temporary.clone(),
        detail,
    })?;
    Ok(Staged {
        target: target.to_path_buf(),
        document,
        temporary: Some(temporary),
    })
}

/// Writes `contents` into `temporary`, under the permissions of `document`.
///
/// **The rename swaps the inodes, so the mode the temporary carries is the mode
/// the document ends up with.** Created from nothing, a file gets what the
/// process umask leaves of `0666` — commonly `0644`. A settings file its owner
/// had restricted to `0600` because it holds tokens would therefore come out of
/// a pose readable by every account on the machine, silently, with success
/// reported. The product does not destroy what the owner of a document wrote,
/// and the mode is part of what they wrote.
///
/// The mode is read from the **designated document** — the one the rename
/// replaces — and not from the path the caller gave: a symbolic link carries a
/// mode of its own, and it is not the one of the document behind it.
///
/// It is set twice, and neither call is redundant. At creation, so that the
/// content never exists on disk under a mode wider than the document's own; then
/// on the open file, because the first mode is only a request — the umask can
/// only take bits away from it, and it applies to nothing at all if a temporary
/// left behind by an interrupted run is being truncated rather than created.
fn write_alongside(document: &Path, temporary: &Path, contents: &str) -> io::Result<()> {
    use std::io::Write;

    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mode = fs::metadata(document)?.permissions().mode() & 0o7777;
        options.mode(mode);
        fs::Permissions::from_mode(mode)
    };
    // Elsewhere, permissions are not a mode and the notion this carries over does
    // not exist; the parameter is read on the platforms where it does.
    #[cfg(not(unix))]
    let _ = document;

    let mut file = options.open(temporary)?;
    #[cfg(unix)]
    file.set_permissions(permissions)?;
    file.write_all(contents.as_bytes())
}

/// How many links a path may chain before the walk refuses. A link pointing at
/// itself loops without this bound, and this module has to say so itself: nobody
/// else will read this path.
const MAX_LINKS: usize = 40;

/// The document `target` designates: `target` itself, or what it points to when
/// it is a symbolic link — the final link, following the chain.
///
/// Only the **last segment** is resolved, and not the whole path: an intermediate
/// directory that happened to be a link changes nothing about the document
/// designated, and resolving it would make refusals name a path the owner of the
/// document never wrote.
pub(crate) fn designated_document(target: &Path) -> Result<PathBuf, TxnError> {
    let mut path = target.to_path_buf();
    for _ in 0..MAX_LINKS {
        let metadata = fs::symlink_metadata(&path).map_err(|detail| TxnError::Read {
            path: target.to_path_buf(),
            detail,
        })?;
        if !metadata.file_type().is_symlink() {
            return Ok(path);
        }
        let pointed_to = fs::read_link(&path).map_err(|detail| TxnError::Read {
            path: target.to_path_buf(),
            detail,
        })?;
        path = if pointed_to.is_absolute() {
            pointed_to
        } else {
            // A relative link reads from the directory of the link, never from
            // the current directory of the process.
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join(pointed_to)
        };
    }
    Err(TxnError::Read {
        path: target.to_path_buf(),
        detail: io::Error::other(format!(
            "more than {MAX_LINKS} symbolic links chained — the designated document is not \
             determinable"
        )),
    })
}

/// The path of a document's temporary: same directory, name derived from its own
/// and from the process identifier.
fn temporary_path(document: &Path) -> PathBuf {
    let name = document
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".to_string());
    let directory = document.parent().unwrap_or_else(|| Path::new("."));
    directory.join(format!(".{name}.rigger-{}.tmp", std::process::id()))
}

/// Why a pose did not happen.
#[derive(Debug)]
pub enum ApplyError {
    /// The merge did not happen: grammar not admitted, refusal from the grammar,
    /// or post-condition failed.
    Merge(MergeError),
    /// Reading or writing the document did not happen.
    Txn(TxnError),
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Merge(err) => write!(f, "{err}"),
            Self::Txn(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for ApplyError {}

impl From<MergeError> for ApplyError {
    fn from(err: MergeError) -> Self {
        Self::Merge(err)
    }
}

impl From<TxnError> for ApplyError {
    fn from(err: TxnError) -> Self {
        Self::Txn(err)
    }
}

/// Merges `edit` into the document at `path` and returns the trace that undoes
/// it.
///
/// The full sequence, and there is no other: capture, merge — admission gate,
/// edit, post-condition —, temporary, re-check, rename. Every step fails leaving
/// the document as it was.
///
/// **The re-check compares against the fingerprint the capture returned, and the
/// document is never read again to obtain it.** That is the whole guard, and it
/// is this line that carries it: taking the expected fingerprint from a fresh
/// read here would compare the document with itself, always match, and let a
/// rewrite landing between the capture and the rename go through unseen — the
/// pose would replace it, and report success.
///
/// **The document is already rewritten when this returns**, at the `commit`
/// below, and what comes back is the only thing that reverses it. Dropping it
/// does not lose an intention: it loses the undo of an edit that has landed.
///
/// ```compile_fail
/// #![deny(unused_must_use)]
/// use std::path::Path;
/// use rigger_apply::merge_into_file;
/// use rigger_grammar::{Edit, Jsonc};
///
/// merge_into_file::<Jsonc>(
///     Path::new("settings.json"),
///     &Edit::values(&["instructions"], ["docs/pose.md"]),
/// )
/// .unwrap();
/// ```
///
/// Its twin, which differs by the one gesture and compiles — without it the
/// refusal above would be indistinguishable from a typo:
///
/// ```no_run
/// use std::path::Path;
/// use rigger_apply::merge_into_file;
/// use rigger_grammar::{Edit, Jsonc};
///
/// let undo = merge_into_file::<Jsonc>(
///     Path::new("settings.json"),
///     &Edit::values(&["instructions"], ["docs/pose.md"]),
/// )
/// .unwrap();
/// record(undo);
/// # fn record(_: rigger_grammar::Inverse) {}
/// ```
///
/// **The attribute that refuses the first of those is on [`Inverse`] itself, in
/// `rigger-grammar`, and moving it onto this function would measure nothing.**
/// The reason is worth the paragraph, because the move looks like a
/// simplification — it would keep the attribute in the crate that carries the
/// danger. Both real call sites read `merge_into_file(..).expect(..)`, and the
/// `expect` *uses* what the function returned. A `must_use` on the function is
/// satisfied there. What gets dropped is the [`Inverse`] one level down, after
/// the unwrapping, and only an attribute on the type sees that far.
///
/// Worse than useless: it would have passed its own pair of doctests. A
/// `compile_fail` written against the bare `merge_into_file(..);` form goes red
/// under a function attribute, so the witness would have looked satisfied while
/// the form that actually occurs stayed open. That is the limit of the
/// instrument — `compile_fail` asserts "does not build", never "does not build
/// for my reason" — meeting a real case.
///
/// The general form, so that it need not be rediscovered per type: **a
/// `must_use` on a function returning [`Result`] adds nothing at all**, because
/// the standard library already marks `Result` itself. It would catch only the
/// bare call, which warns today without any of this.
pub fn merge_into_file<G: Grammar>(path: &Path, edit: &Edit) -> Result<Inverse, ApplyError> {
    let captured = capture(path)?;
    let merged = merge::<G>(captured.content(), edit)?;
    let staged = stage(path, &merged.rendered)?;
    staged.commit(captured.fingerprint())?;
    Ok(merged.inverse)
}
