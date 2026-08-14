//! Confines a relative path this crate read out of untrusted catalogue data
//! — an entry's `id`, or its `path` field — to resolve under a root this
//! crate chose itself.
//!
//! Shared by [`crate::install`], which confines the address a pose writes
//! to (root: the equipped directory), and [`crate::source`], which confines
//! the file a pose reads from (root: the catalogue's own directory,
//! ADR-0048). Two different roots, the same three ways a relative path
//! built from data neither crate wrote can leave one.

use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Why [`confine`] refused a candidate path before anything was read or
/// written through it.
#[derive(Debug)]
pub enum ConfinementError {
    /// The candidate is an absolute path — joining it to the root would
    /// replace the root outright rather than resolve under it.
    Absolute {
        /// The candidate that was refused.
        relative: PathBuf,
    },
    /// The candidate carries a `..` component, which would resolve above
    /// the root rather than under it.
    Traversal {
        /// The candidate that was refused.
        relative: PathBuf,
    },
    /// Once existing symlinks on this filesystem are followed, the
    /// candidate resolves to a path outside the root.
    Symlink {
        /// The candidate that was refused.
        relative: PathBuf,
    },
    /// The root, or the deepest of the candidate's own leading directories
    /// that exists, could not be resolved at all.
    Io {
        /// The path that could not be resolved.
        path: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
}

impl fmt::Display for ConfinementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absolute { relative } => write!(
                f,
                "resolves to the absolute path `{}` — it must resolve under the root, not replace \
                 it",
                relative.display()
            ),
            Self::Traversal { relative } => write!(
                f,
                "resolves to `{}`, which leaves the root through a `..` component",
                relative.display()
            ),
            Self::Symlink { relative } => write!(
                f,
                "resolves to `{}`, which an existing symlink on this filesystem leads outside the \
                 root",
                relative.display()
            ),
            Self::Io { path, detail } => write!(
                f,
                "cannot resolve `{}` to check it stays under the root — {detail}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for ConfinementError {}

/// The exit code owed for a [`ConfinementError`].
///
/// [`ConfinementError::Io`] is a fact about this machine — the root or one
/// of its own directories could not be resolved — so it answers
/// [`crate::RUNTIME_FAILURE`]; the other three are facts about the candidate
/// itself, fixed only by naming a different one, so they answer
/// [`crate::REQUEST_CANNOT_BE_SATISFIED`].
pub fn exit_code(err: &ConfinementError) -> u8 {
    match err {
        ConfinementError::Absolute { .. }
        | ConfinementError::Traversal { .. }
        | ConfinementError::Symlink { .. } => crate::REQUEST_CANNOT_BE_SATISFIED,
        ConfinementError::Io { .. } => crate::RUNTIME_FAILURE,
    }
}

/// Refuses to let `relative` resolve to anywhere outside `root`: an
/// absolute path, a `..` component, or (the one those two checks cannot
/// see) an existing symlink among `root`'s own children that this
/// filesystem would follow outside it. Returns the joined path on success —
/// still not guaranteed to exist, only guaranteed to resolve under `root`
/// as far as this filesystem can be asked today.
pub fn confine(root: &Path, relative: &Path) -> Result<PathBuf, ConfinementError> {
    if relative.is_absolute() {
        return Err(ConfinementError::Absolute {
            relative: relative.to_path_buf(),
        });
    }
    if relative
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ConfinementError::Traversal {
            relative: relative.to_path_buf(),
        });
    }

    let canonical_root = root.canonicalize().map_err(|detail| ConfinementError::Io {
        path: root.to_path_buf(),
        detail,
    })?;

    // `joined` may not exist yet — only its deepest existing ancestor can be
    // canonicalised, and that ancestor is exactly where a symlink escaping
    // `root` would have to sit, since nothing past it exists on this
    // filesystem for the resolution to run through.
    let joined = root.join(relative);
    let mut probe: &Path = &joined;
    while !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    let canonical_probe = probe
        .canonicalize()
        .map_err(|detail| ConfinementError::Io {
            path: probe.to_path_buf(),
            detail,
        })?;
    if !canonical_probe.starts_with(&canonical_root) {
        return Err(ConfinementError::Symlink {
            relative: relative.to_path_buf(),
        });
    }

    Ok(joined)
}
