//! The exclusion between runs of the product, under which the registry's
//! reading, decision and write hold together.
//!
//! **It surrounds the write window, and never the whole run.** A lock taken
//! around a run would be held by a confirmation prompt left open, and the
//! machine would become unusable by a gesture its owner connects to nothing.
//! That is why acquiring is a gesture of its own here rather than a wrapper
//! around an execution: the caller asks for consent first, and acquires
//! afterwards. A read path does not acquire at all.
//!
//! **The lock file lives beside the registry, derived from its path.** It
//! protects the registry, so a fixed path would stop protecting it the moment
//! the registry is relocated — which an environment override already allows and
//! which profiles will make routine, two registries then sharing one exclusion
//! that designates neither.
//!
//! **Acquiring fails fast; it never waits.** A blocking acquisition turns a
//! contended registry into a hung process, which is the one failure a caller
//! cannot act on.
//!
//! # What is decided here, and what is only observed
//!
//! Three verdicts drive every decision, and none of them is a boolean.
//!
//! A holder's liveness is [`Liveness`], with **three** values. The system test
//! that answers it fails for a live process belonging to another user exactly as
//! it fails for a process that is gone: folding that indeterminacy onto "dead"
//! would break the lock of a living run and open two writers onto the same owned
//! document. So an indeterminate holder is refused **by naming the
//! indeterminacy and its reason**, and the lock is left alone.
//!
//! Breaking a lock is an **exchange conditioned on the identity of what was
//! observed** — [`Lock::observe`] then [`Lock::break_if_unchanged`] — and never
//! a bare removal. A bare removal leaves a window in which a third party creates
//! its own lock and has it destroyed, which reopens the two concurrent writers
//! the lock exists to close.
//!
//! **What no test here establishes, and what holds it instead.** The exchange
//! shows that the break *is* conditioned; it does not show that it is atomic.
//! That second property is held by the choice of primitive — an exclusive
//! creation for taking, a rename for breaking, both of which the kernel settles
//! between racing processes — and not by an assertion. The residual
//! third-order race between the rename away and the rename back is assumed:
//! it is narrower than the lost update it replaces, and closing it would need a
//! lock primitive with verified identity that the filesystem does not offer.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The first field of a lock file, and its format version. A lock file that does
/// not open with it is not one this product wrote.
const FORMAT: &str = "rigger-lock";

/// The format version this build writes and reads.
const FORMAT_VERSION: u32 = 1;

/// How long a lock stays valid before its holder may be examined at all.
///
/// **Expiry alone never breaks anything**: a lock is broken only when it is past
/// this and its holder is observed dead. The two conditions are not
/// interchangeable. A long, legitimate run holds a lock older than this and is
/// never broken because its holder is alive; a run that crashed a second ago
/// leaves a lock whose holder is dead and is not broken either, which is what
/// keeps a recycled process identifier from triggering a wrongful break.
///
/// Fifteen minutes is the value the archived implementation used and nothing
/// measured has moved it: it is far longer than any write window here, and the
/// cost of it being too long is a wait, where the cost of it being too short is
/// two writers on one document.
///
/// It is public because it is a term of the contract — how long a crashed run
/// keeps a registry to itself — and because a test that placed a lock either
/// side of it by restating the number would drift from it the day it changes.
pub const VALIDITY: Duration = Duration::from_secs(15 * 60);

/// What is known about the process that holds a lock.
///
/// **Three values, and the third is the point.** A boolean has no room for the
/// case where the system refuses to answer, so it turns a refusal to answer into
/// a death — and the lock of a living run belonging to another user gets broken.
/// Written as a type, that fold is not expressible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Liveness {
    /// The process exists.
    Alive,
    /// The process does not exist.
    Dead,
    /// The system did not answer, and the reason is carried rather than
    /// discarded: it is what the refusal has to name.
    Undetermined {
        /// Why the answer could not be obtained, as the system reported it.
        reason: String,
    },
}

/// **Public surface, and declared as such**: the liveness of a process
/// identifier is provided to this module rather than read by it.
///
/// What it makes measurable: the decision taken on an **indeterminate** holder.
/// Manufacturing a real indeterminate answer needs a live process owned by
/// another user; the obvious candidate answers "alive" when the suite runs as
/// root, which most containers do. A test written against the system probe would
/// therefore be green on a developer's machine and green on a build machine
/// while measuring nothing on one of them, with nothing to say so.
///
/// What it costs: one parameter on acquiring and on breaking, and the temptation
/// to believe that the test of the decision covers the real probe. It does not.
/// Whether [`SystemLiveness`] really answers `Undetermined` on a permission
/// refusal is a measurement of a machine, and it belongs with the other
/// characterizations of the environment.
pub trait LivenessProbe {
    /// What is known about the process with this identifier.
    fn liveness(&self, pid: u32) -> Liveness;
}

/// The one implementation that asks the operating system.
///
/// It sends signal zero, which performs the existence and permission checks and
/// delivers nothing. Success means the process exists. A permission refusal
/// means it exists and belongs to somebody else — indeterminate for our purpose,
/// never dead. Only "no such process" is dead.
pub struct SystemLiveness;

/// The error number POSIX gives for "no such process".
///
/// It is 3 on Linux and on macOS, the two systems this product is released for,
/// and the standard library gives no stable name for it. A system where it is
/// something else falls into the arm below that answers `Undetermined`, so the
/// mistake costs a refusal to break a lock, never a wrongful break.
#[cfg(unix)]
const ESRCH: i32 = 3;

#[cfg(unix)]
extern "C" {
    /// `kill(2)`. Declared here rather than taken from a crate: this crate has
    /// no third-party dependency on the path that touches a user's files, and
    /// the standard library links the C library anyway.
    fn kill(pid: i32, sig: i32) -> i32;
}

impl LivenessProbe for SystemLiveness {
    #[cfg(unix)]
    fn liveness(&self, pid: u32) -> Liveness {
        let Ok(pid) = i32::try_from(pid) else {
            return Liveness::Undetermined {
                reason: format!("{pid} is not a process identifier this system can be asked about"),
            };
        };
        if pid <= 0 {
            return Liveness::Undetermined {
                reason: format!(
                    "{pid} designates a process group or the caller itself, not one process"
                ),
            };
        }
        // Signal zero delivers nothing: it performs the existence and permission
        // checks only.
        if unsafe { kill(pid, 0) } == 0 {
            return Liveness::Alive;
        }
        let reported = io::Error::last_os_error();
        if reported.raw_os_error() == Some(ESRCH) {
            return Liveness::Dead;
        }
        Liveness::Undetermined {
            reason: reported.to_string(),
        }
    }

    /// Elsewhere, nothing here can ask. The answer is the one that refuses to
    /// act rather than the one that is convenient.
    #[cfg(not(unix))]
    fn liveness(&self, pid: u32) -> Liveness {
        Liveness::Undetermined {
            reason: format!("this system offers no way to ask whether process {pid} exists"),
        }
    }
}

/// Why a lock was not taken. No variant advises a remedy: a product that states
/// a remedy it cannot itself carry out under backup manufactures the loss it
/// claims to avoid.
#[derive(Debug)]
pub enum LockError {
    /// Another run holds it, and that run is not breakable.
    Held {
        /// The lock file.
        path: PathBuf,
        /// The process it records as holding it.
        pid: u32,
    },
    /// The holder's liveness could not be determined. The lock was **not**
    /// broken.
    UndeterminedHolder {
        /// The lock file.
        path: PathBuf,
        /// The process it records as holding it.
        pid: u32,
        /// What the system reported instead of an answer.
        reason: String,
    },
    /// The lock file is there and does not read as one. Neither its holder nor
    /// its age can be judged, so it is not broken either.
    Unreadable {
        /// The lock file.
        path: PathBuf,
        /// What could not be read in it.
        reason: String,
    },
    /// The lock changed between the observation and the break: somebody else's
    /// lock is at that path now, and it was left there.
    IdentityChanged {
        /// The lock file.
        path: PathBuf,
    },
    /// The lock file could not be read, written or moved.
    Io {
        /// The lock file.
        path: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Held { path, pid } => write!(
                f,
                "{}: another run of the product holds the registry, recorded as process {pid}",
                path.display()
            ),
            Self::UndeterminedHolder { path, pid, reason } => write!(
                f,
                "{}: whether process {pid} still runs could not be determined — {reason}; the lock \
                 was left in place, because the same answer comes back for a living run belonging \
                 to another user",
                path.display()
            ),
            Self::Unreadable { path, reason } => write!(
                f,
                "{}: this does not read as a lock of the product — {reason}; neither its holder \
                 nor its age can be judged, so it was left in place",
                path.display()
            ),
            Self::IdentityChanged { path } => write!(
                f,
                "{}: the lock changed between the moment it was observed and the moment it would \
                 have been broken — it belongs to another run now, and it was left in place",
                path.display()
            ),
            Self::Io { path, detail } => {
                write!(f, "{}: {detail}", path.display())
            }
        }
    }
}

impl std::error::Error for LockError {}

/// The lock beside one registry.
///
/// It is a **path**, computed from the registry's own: this type never learns
/// where a registry lives, it is told. That is what lets two registries be
/// exercised side by side, and it is what an environment override needs — the
/// variable is read once, at the edge of the command surface, and travels as a
/// value from there.
#[derive(Debug, Clone)]
pub struct Lock {
    path: PathBuf,
}

impl Lock {
    /// The lock of the registry at this path: the same name, with the lock
    /// suffix, in the same directory.
    pub fn beside(registry: &Path) -> Self {
        let name = registry
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "registry".to_string());
        let directory = registry.parent().unwrap_or_else(|| Path::new("."));
        Self {
            path: directory.join(format!("{name}.lock")),
        }
    }

    /// Where the lock file is.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Takes the lock, or fails at once.
    ///
    /// A lock already there is broken only when **both** its validity has run
    /// out and its holder is observed dead. Either condition alone leaves it
    /// standing, and an indeterminate holder leaves it standing while naming
    /// what could not be determined.
    pub fn acquire(&self, probe: &dyn LivenessProbe) -> Result<Held, LockError> {
        match self.create() {
            Ok(held) => return Ok(held),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
            Err(detail) => {
                return Err(LockError::Io {
                    path: self.path.clone(),
                    detail,
                })
            }
        }

        let Some(observed) = self.observe()? else {
            // It went away between the failed creation and the read: its holder
            // released it. One retry, and no loop — a caller that must wait is
            // told so rather than made to spin.
            return self.create().map_err(|detail| LockError::Io {
                path: self.path.clone(),
                detail,
            });
        };

        let holder = observed.holder()?;
        if !observed.is_expired(holder) {
            return Err(LockError::Held {
                path: self.path.clone(),
                pid: holder.pid,
            });
        }
        match probe.liveness(holder.pid) {
            Liveness::Alive => Err(LockError::Held {
                path: self.path.clone(),
                pid: holder.pid,
            }),
            Liveness::Undetermined { reason } => Err(LockError::UndeterminedHolder {
                path: self.path.clone(),
                pid: holder.pid,
                reason,
            }),
            Liveness::Dead => self.break_if_unchanged(observed, probe),
        }
    }

    /// **Public surface, and declared as such**: the first of the two gestures a
    /// break is made of. It reads the lock and takes nothing.
    ///
    /// What it makes measurable: that a break is conditioned on what was
    /// observed. The identity it carries is the bytes that were **read**, and
    /// never a value re-derived when the comparison happens — a re-derived
    /// identity compares the lock with itself, always matches, and leaves an
    /// unconditional break looking conditioned.
    ///
    /// `Ok(None)` means there was no lock to observe.
    pub fn observe(&self) -> Result<Option<Observed>, LockError> {
        match fs::read_to_string(&self.path) {
            Ok(identity) => Ok(Some(Observed {
                path: self.path.clone(),
                identity,
                observed_at: now_seconds(),
            })),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(detail) => Err(LockError::Io {
                path: self.path.clone(),
                detail,
            }),
        }
    }

    /// **Public surface, and declared as such**: the second gesture. It replaces
    /// the observed lock by ours, and only if nothing has replaced it since.
    ///
    /// What it makes measurable: that a lock recreated by a third party between
    /// the observation and the break is **not** overwritten. Written as a
    /// removal followed by a creation, that property has no instrument at all —
    /// the third party's lock is gone and nothing recorded that it had been
    /// there.
    ///
    /// The liveness of the recorded holder is checked again here, at the moment
    /// of acting: a verdict taken earlier describes a process that has had time
    /// to change state.
    pub fn break_if_unchanged(
        &self,
        observed: Observed,
        probe: &dyn LivenessProbe,
    ) -> Result<Held, LockError> {
        let holder = observed.holder()?;
        match probe.liveness(holder.pid) {
            Liveness::Alive => {
                return Err(LockError::Held {
                    path: self.path.clone(),
                    pid: holder.pid,
                })
            }
            Liveness::Undetermined { reason } => {
                return Err(LockError::UndeterminedHolder {
                    path: self.path.clone(),
                    pid: holder.pid,
                    reason,
                })
            }
            Liveness::Dead => {}
        }

        // Moving the observed lock aside is what settles the race: of several
        // runs that judged the same lock breakable, only one renames it, and a
        // rename never touches a lock created afterwards under the same path.
        let aside = self
            .path
            .with_extension(format!("stale-{}", std::process::id()));
        match fs::rename(&self.path, &aside) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                // Already gone. The exclusive creation below still settles who
                // holds it.
                return self.create().map_err(|detail| LockError::Io {
                    path: self.path.clone(),
                    detail,
                });
            }
            Err(detail) => {
                return Err(LockError::Io {
                    path: self.path.clone(),
                    detail,
                })
            }
        }

        let moved = fs::read_to_string(&aside).unwrap_or_default();
        if moved != observed.identity {
            // A fresh run had replaced it: we have just moved a live lock. Put
            // it back and refuse.
            let _ = fs::rename(&aside, &self.path);
            return Err(LockError::IdentityChanged {
                path: self.path.clone(),
            });
        }
        let _ = fs::remove_file(&aside);

        self.create().map_err(|detail| {
            if detail.kind() == io::ErrorKind::AlreadyExists {
                return LockError::Held {
                    path: self.path.clone(),
                    pid: holder.pid,
                };
            }
            LockError::Io {
                path: self.path.clone(),
                detail,
            }
        })
    }

    /// Creates the lock file, and fails if it is already there. The kernel
    /// settles the race between two runs creating it at once; nothing in user
    /// space could.
    fn create(&self) -> io::Result<Held> {
        use std::io::Write;

        if let Some(directory) = self.path.parent() {
            fs::create_dir_all(directory)?;
        }
        let identity = format!(
            "{FORMAT} {FORMAT_VERSION} {} {}\n",
            std::process::id(),
            now_seconds()
        );
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.path)?;
        file.write_all(identity.as_bytes())?;
        Ok(Held {
            path: self.path.clone(),
            identity,
        })
    }
}

/// The process a lock records, and when it took it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Holder {
    pid: u32,
    taken_at: u64,
}

/// A lock as it was **read**, carrying the identity the break is conditioned on.
///
/// Only [`Lock::observe`] and nothing else makes one, and the identity it holds
/// is the bytes that read came back with. Re-deriving it at comparison time
/// would compare the lock with itself.
#[derive(Debug, Clone)]
pub struct Observed {
    path: PathBuf,
    identity: String,
    observed_at: u64,
}

impl Observed {
    /// The lock file this was read from.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The process it records, or a refusal that names what could not be read.
    fn holder(&self) -> Result<Holder, LockError> {
        let unreadable = |reason: &str| LockError::Unreadable {
            path: self.path.clone(),
            reason: reason.to_string(),
        };
        let line = self
            .identity
            .lines()
            .next()
            .ok_or_else(|| unreadable("it is empty"))?;
        let mut fields = line.split(' ');
        if fields.next() != Some(FORMAT) {
            return Err(unreadable("it does not open with the lock marker"));
        }
        let version = fields
            .next()
            .ok_or_else(|| unreadable("it carries no format version"))?;
        if version != FORMAT_VERSION.to_string() {
            return Err(LockError::Unreadable {
                path: self.path.clone(),
                reason: format!(
                    "it declares format version {version}, and this build reads {FORMAT_VERSION}"
                ),
            });
        }
        let pid = fields
            .next()
            .and_then(|field| field.parse::<u32>().ok())
            .ok_or_else(|| unreadable("it carries no readable process identifier"))?;
        let taken_at = fields
            .next()
            .and_then(|field| field.parse::<u64>().ok())
            .ok_or_else(|| unreadable("it carries no readable moment of acquisition"))?;
        Ok(Holder { pid, taken_at })
    }

    /// Whether the validity of the lock has run out.
    ///
    /// Measured against the moment the lock **records**, and not against the
    /// modification time of its file: a file's timestamps are rewritten by
    /// things that have nothing to do with the run holding it.
    ///
    /// A lock taken in the future — a clock that moved — is not expired. It is
    /// the arm that refuses.
    fn is_expired(&self, holder: Holder) -> bool {
        self.observed_at.saturating_sub(holder.taken_at) > VALIDITY.as_secs()
    }
}

/// **The proof that the lock is held.**
///
/// This is not ceremony, and the file plan's own account of what it costs is the
/// reason it exists. A harness can measure that the registry is re-read and
/// replayed before the write, and it can measure that the lock is taken. It
/// cannot measure that the two surround the **same window**: code that re-reads,
/// replays, and takes the lock *afterwards* passes both measurements and loses
/// updates exactly as if neither existed. No sequential test makes the two
/// versions diverge, because with one run at a time they produce the same file.
///
/// So the property is carried by the type instead. A value of this type is made
/// by acquiring and by nothing else, and dropping it releases the lock. The
/// re-read of the registry borrows one, and the write consumes what the re-read
/// produced. The wrong wiring — re-read, replay, then acquire — stops being a
/// thing anybody can write down, and the compiler holds what a race one hopes to
/// reproduce would not.
#[derive(Debug)]
pub struct Held {
    path: PathBuf,
    identity: String,
}

impl Held {
    /// The lock file this holds.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Held {
    /// Releases the lock, and only if it is still ours.
    ///
    /// The comparison is the same discipline as the break: removing by path
    /// alone would delete the lock of the run that broke ours and took it,
    /// leaving two runs believing they hold it.
    fn drop(&mut self) {
        if fs::read_to_string(&self.path).ok().as_deref() == Some(self.identity.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Seconds since the epoch. A clock that reads before the epoch gives zero,
/// which makes every lock look freshly taken — the arm that refuses to break.
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// Seconds since the epoch, as this module writes them into a lock.
///
/// It is public because a lock has to be **forgeable from outside** for the two
/// conditions of a break to be told apart: killing the mutation that drops the
/// validity check needs a lock whose holder is dead and which is not expired,
/// and one whose holder is dead and which is — neither of which can be obtained
/// by waiting, and both of which are exact when the moment of acquisition is
/// written rather than taken from the file's own timestamps.
pub fn seconds_since_epoch() -> u64 {
    now_seconds()
}
