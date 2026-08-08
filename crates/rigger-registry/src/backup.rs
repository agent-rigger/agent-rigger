//! The copy a write takes of the registry before it replaces it, and how a later
//! run tells a whole copy from one whose own write was interrupted.
//!
//! # Why a copy at all
//!
//! The registry is the only link between something posed and its undoing, and a
//! write replaces it whole. Between the moment the old bytes stop being the file
//! and the moment the new ones become it, there is a machine whose entire record
//! exists in one place; a run that dies in that interval, or a registry this
//! build cannot read in the first place, must not cost that record. So the
//! registry is copied beside itself before it is replaced, and the copy is taken
//! away only once the replacement is on disk.
//!
//! # The witness is written last, and truncation is read from its absence
//!
//! A copy is worth nothing unless a later run can tell a whole one from one cut
//! short. **Restoring an amputated copy as though it were whole is worse than
//! having no copy at all**: everything its missing lines described stays on the
//! machine with nothing able to reach it, permanently unremovable, with no error
//! and nobody noticing. That is the one damage this crate exists against, and it
//! would be produced here by the very gesture meant to prevent it.
//!
//! So the copy carries a **witness line, written after everything else**, and a
//! copy without it is truncated. The mechanism is the ordering of two writes,
//! and the property is observable on the file alone — never an assumption about
//! how the file came to be.
//!
//! **The alternative was to publish the copy indivisibly**, the way the
//! exclusion publishes its lock: write it beside itself, force it out, and link
//! it into place under its name, so that it exists whole or does not exist. It
//! was not taken, and for one reason: it makes an interrupted copy
//! *unobservable*, and what A2 requires is precisely that one be recognised and
//! named. A checksum would do the same work at a higher price, and no scenario
//! asks a copy to be told from a corrupted one — only from an unfinished one.
//!
//! # What the witness says, and why it is not just a marker
//!
//! It says **how many bytes it certifies**. The file being copied is, by
//! construction, one this build may not be able to read, so nothing may be
//! assumed about what is in it — including that none of its own lines is shaped
//! like a witness. A marker alone would then let a copy that stopped on such a
//! line read as whole. The declared length ties the witness to the file it sits
//! at the end of, and it costs one integer.
//!
//! It is **not** a checksum, and it is not offered as one: it says the write
//! reached the end, not that the bytes in between are the ones that were handed
//! to it.
//!
//! # What no test here establishes, and what holds it instead
//!
//! That the witness reaches the disk after the content it certifies is a
//! property of the order of two writes with a flush between them, not of an
//! assertion: staging a failure between them would need a seam through the path
//! that copies a user's registry. What the tests measure is the residue — a file
//! carrying its witness is whole, a file without one is not, and neither
//! judgement is made from the file's mere existence.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::ledger::RegistryError;

/// The word the witness line opens with. It is the copy's own vocabulary and not
/// the registry's: nothing of this is written into the registry, whose format is
/// untouched by any of it.
const WITNESS: &str = "rigger-registry-backup";

/// What a copy's name adds to the registry's own.
const SUFFIX: &str = ".rigger-backup";

/// A copy of the registry, and what reading it is worth.
///
/// **The variants carry what may be done with them, so that the wrong thing
/// cannot be written down.** Only [`Backup::Complete`] holds a document, which
/// is what makes "a truncated copy is not offered as a state to resume from" a
/// property of the type rather than of a caller's care: there is nothing to
/// offer. A boolean beside a document would let the two disagree, and the run
/// that read it wrongly would restore an amputated registry.
#[derive(Debug)]
pub enum Backup {
    /// No copy is beside the registry. Nothing was interrupted between a copy
    /// being taken and the registry being written.
    Absent,
    /// A copy carrying its witness: it accounts for its own length, so the write
    /// that produced it reached the end.
    Complete {
        /// The copy's file.
        path: PathBuf,
        /// The registry as it stood when the copy was taken — the state a run
        /// may resume from.
        document: Vec<u8>,
    },
    /// A copy that does not carry its witness: the write that produced it
    /// stopped partway.
    ///
    /// **It holds no document.** How much of the registry is missing from it
    /// cannot be told from it, so no part of it is offered: restored as though
    /// it were whole, it would take the description of everything the missing
    /// lines named off the machine, and leave every one of those things where it
    /// was posed with nothing able to reach it.
    Truncated {
        /// The copy's file.
        path: PathBuf,
    },
    /// A copy that is there and could not be read from the disk. It is named,
    /// and it is not offered either: nothing here knows what is in it.
    Unreadable {
        /// The copy's file.
        path: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
}

impl Backup {
    /// Reads whatever copy is beside this registry, and says what it is worth.
    ///
    /// **Takes nothing and writes nothing.** It is the gesture a run makes
    /// before it does anything else, and a gesture that wrote would put this
    /// path among the writers the registry's exclusion exists to order, without
    /// it ever having taken that exclusion.
    pub fn beside(registry: &Path) -> Self {
        let path = copy_of(registry);
        let copy = match fs::read(&path) {
            Ok(copy) => copy,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Self::Absent,
            Err(detail) => return Self::Unreadable { path, detail },
        };
        match certified(&copy) {
            Some(length) => Self::Complete {
                document: copy[..length].to_vec(),
                path,
            },
            None => Self::Truncated { path },
        }
    }

    /// Copies the registry beside itself, witness last, and answers with the
    /// copy that now exists.
    ///
    /// A registry that is not there answers [`Backup::Absent`]: nothing has been
    /// posed on that machine, so there is nothing a later run could want back.
    /// A copy already there is replaced — it belongs to a write that finished,
    /// or to one this run is about to finish itself.
    ///
    /// **The bytes are copied and not re-rendered.** Rendering the registry this
    /// crate parsed would write back what this build understood of it, and the
    /// point of the copy is the file as its owner has it, including whatever
    /// this build could not read.
    pub fn take(registry: &Path) -> Result<Self, RegistryError> {
        let document = match fs::read(registry) {
            Ok(document) => document,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Self::Absent),
            Err(detail) => {
                return Err(RegistryError::Read {
                    path: registry.to_path_buf(),
                    detail,
                })
            }
        };
        let path = copy_of(registry);
        write_copy(registry, &path, &document).map_err(|detail| RegistryError::Write {
            path: path.clone(),
            detail,
        })?;
        Ok(Self::Complete { path, document })
    }

    /// The copy's file, when there is one to name.
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Absent => None,
            Self::Complete { path, .. }
            | Self::Truncated { path }
            | Self::Unreadable { path, .. } => Some(path),
        }
    }
}

impl fmt::Display for Backup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absent => write!(f, "no copy of the registry is beside it"),
            Self::Complete { path, document } => write!(
                f,
                "{}: a whole copy of the registry, {} bytes, left by a run that was interrupted \
                 before it wrote",
                path.display(),
                document.len()
            ),
            Self::Truncated { path } => write!(
                f,
                "{}: a copy of the registry whose own write was interrupted — it does not carry \
                 the witness written last, so it is truncated, nothing here can tell how much of \
                 it is missing, and it is not offered as a state to resume from",
                path.display()
            ),
            Self::Unreadable { path, detail } => write!(
                f,
                "{}: a copy of the registry that cannot be read — {detail} — so it is not offered \
                 as a state to resume from",
                path.display()
            ),
        }
    }
}

/// Where the copy of a registry lives: beside it, under its own name.
///
/// **Derived from the registry's path, and never a fixed location.** A fixed one
/// is shared by every registry on the machine, so the copy of one answers for
/// another: a run that relocates its registry would be handed back, as its state
/// to resume from, a registry it has never seen. It also follows the registry
/// when it moves, which is what the exclusion beside it already does.
///
/// The name carries no process identifier, unlike the temporary of a write. That
/// is the whole point of it: the run that reads this copy is, by construction,
/// not the run that wrote it.
fn copy_of(registry: &Path) -> PathBuf {
    let name = registry
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "registry".to_string());
    let directory = registry.parent().unwrap_or_else(|| Path::new("."));
    directory.join(format!("{name}{SUFFIX}"))
}

/// How many bytes of this copy the witness accounts for, or nothing when it
/// carries no witness.
///
/// A whole copy is the document, a separator, then the witness line. The
/// separator is written by this format and is not part of the document: a
/// registry whose last byte is not a line break would otherwise have the witness
/// glued to its final line, and no reader could find it again.
fn certified(copy: &[u8]) -> Option<usize> {
    // The witness line is terminated. A copy cut inside it is not one, and this
    // is where that truncation — the one closest to a whole copy — is caught.
    let lines = copy.strip_suffix(b"\n")?;
    let opens = lines.iter().rposition(|byte| *byte == b'\n')? + 1;
    let witness = std::str::from_utf8(&lines[opens..]).ok()?;
    let declared: usize = witness
        .strip_prefix(WITNESS)?
        .strip_prefix(' ')?
        .parse()
        .ok()?;
    // The separator sits at `declared`, and the witness line opens right after
    // it. Without this, a copy that stopped on a line of its own shaped like a
    // witness would read as whole.
    if declared.checked_add(1)? != opens {
        return None;
    }
    Some(declared)
}

/// Writes the copy: the document, the separator, then — after the first two are
/// forced out — the witness.
///
/// **The flush between them is what makes the witness mean anything.** Without
/// it, a power cut may publish the witness while the content it certifies is
/// still in flight, and the file left behind accounts for a length it does not
/// hold. A crash of the process alone does not need it; a machine losing power
/// does, and the two are not distinguishable after the fact.
///
/// **The copy carries the registry's own permissions.** Created from nothing, a
/// file gets what the process umask leaves of `0666` — commonly `0644`. A
/// registry its owner had restricted to `0600` would therefore be copied into a
/// file every account on the machine can read, silently, on the way to
/// protecting it. The same carry-over is done when an owned document is staged
/// for a pose, and for the same reason; it is written out again here rather than
/// shared, because that one is about a temporary the rename turns into the
/// document, and this one is about a second file that stays.
///
/// It is set twice, and neither call is redundant. At creation, so the content
/// never exists on disk under a mode wider than the registry's own; then on the
/// open file, because the first mode is only a request — the umask can only take
/// bits away from it, and it applies to nothing at all when a copy left by an
/// interrupted run is being truncated rather than created.
fn write_copy(registry: &Path, path: &Path, document: &[u8]) -> io::Result<()> {
    use std::io::Write;

    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mode = fs::metadata(registry)?.permissions().mode() & 0o7777;
        options.mode(mode);
        fs::Permissions::from_mode(mode)
    };
    // Elsewhere, permissions are not a mode and the notion this carries over does
    // not exist; the parameter is read on the platforms where it does.
    #[cfg(not(unix))]
    let _ = registry;

    let mut file = options.open(path)?;
    #[cfg(unix)]
    file.set_permissions(permissions)?;

    file.write_all(document)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    file.write_all(format!("{WITNESS} {}\n", document.len()).as_bytes())
}
