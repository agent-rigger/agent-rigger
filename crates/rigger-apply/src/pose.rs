//! Carrying a behaviour's steps out on a disk, **under a transaction that gives
//! the machine back**.
//!
//! # What the rollback replays, and why that choice covers more
//!
//! Before a single step runs, the transaction **seizes** the state of every
//! address the steps are about to change. If a step fails, it gives every one
//! of those states back, in the reverse order they were changed.
//!
//! That is not a compensation written per kind of operation, and the difference
//! is the failure it covers. A compensation table knows how to undo "a write to
//! a file at a path"; the removal of an entry of the **shared store** is not
//! one, and no line of such a table ever mentioned it — so a transaction that
//! failed after taking a store entry away left links on the machine designating
//! nothing, and reported an error about something else. Replaying a seized
//! state has no such blind spot: the store entry is an address like any other,
//! and giving it back is the same gesture as giving a document back.
//!
//! # The address a step touches must be one the capture named
//!
//! [`rigger_plan::Behaviour::capture`] names the addresses; this module refuses
//! any step touching one it did not name. That check is not tidiness: a
//! behaviour that under-declares what it changes leaves the rollback with
//! nothing to give back at that address, and the damage only shows on a machine
//! where a transaction failed — which is nobody's test machine.
//!
//! # The injectable failure point, declared as public surface
//!
//! [`Steps`] is how effects reach the disk, and it is a trait so that a test can
//! make the n-th one fail. Without it, "a pose interrupted after the
//! materialisation and before the registry" needs a process killed at a moment
//! nothing deterministic schedules, and the scenario stops being measurable at
//! all.
//!
//! What it costs is named rather than discovered: **a seam the production path
//! does not go through is itself unmeasured code**. [`OnDisk`] is the only
//! implementation the product uses, and the nominal tests go through it.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rigger_plan::{
    behaviour, record, Behaviour, BehaviourError, BehaviourName, Captured, Digest, Effect,
    Fragment, Referents, Seized, Subject, Trace,
};

use crate::txn::{stage, Fingerprint, TxnError};

/// Why one step did not happen. None of these leaves a step half applied.
#[derive(Debug)]
pub enum StepError {
    /// Something is already at the address, and the product did not put it
    /// there. It is left exactly as it is.
    Occupied {
        /// The address.
        address: PathBuf,
    },
    /// The shared store already holds this entry, under other bytes. One entry
    /// standing for two different contents is the one state a shared store must
    /// never reach: every address designating it would get whichever of the two
    /// was written last.
    StoreConflict {
        /// The store entry.
        address: PathBuf,
    },
    /// What is at the address is not what the trace recorded, so the product
    /// does not take it away. It takes back what it posed, and nothing else.
    NotAsRecorded {
        /// The address.
        address: PathBuf,
        /// What the trace said was there.
        recorded: String,
    },
    /// The directory the address lives in is not there.
    ///
    /// **The product does not make it.** A directory created is a change the
    /// capture would have to seize and the restoration give back, and this
    /// version builds neither — so it refuses by naming the directory rather
    /// than leave one behind that no removal takes away.
    NoDirectory {
        /// The address.
        address: PathBuf,
        /// The directory that is not there.
        directory: PathBuf,
    },
    /// The bytes at the address are not UTF-8, so the product cannot hold them
    /// in order to give them back. It refuses rather than seize them lossily.
    NotUtf8 {
        /// The address.
        address: PathBuf,
    },
    /// The system refused.
    Io {
        /// The address.
        address: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
    /// The conditional write of an owned document did not happen.
    Txn(TxnError),
}

impl fmt::Display for StepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Occupied { address } => write!(
                f,
                "{}: something is already there, and the product did not put it there — it is left \
                 exactly as it is",
                address.display()
            ),
            Self::StoreConflict { address } => write!(
                f,
                "{}: the shared store already holds this entry under other bytes — one entry \
                 cannot stand for two contents, and nothing was changed",
                address.display()
            ),
            Self::NotAsRecorded { address, recorded } => write!(
                f,
                "{}: the trace recorded {recorded} there, and that is not what is there now — the \
                 product takes back what it posed and nothing else, so it left it alone",
                address.display()
            ),
            Self::NoDirectory { address, directory } => write!(
                f,
                "{}: the directory {} is not there, and the product does not make one — a \
                 directory it created is a change no removal would take away",
                address.display(),
                directory.display()
            ),
            Self::NotUtf8 { address } => write!(
                f,
                "{}: these bytes are not UTF-8, and the product does not seize what it could not \
                 give back exactly",
                address.display()
            ),
            Self::Io { address, detail } => {
                write!(f, "{}: {detail}", address.display())
            }
            Self::Txn(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for StepError {}

/// **Public surface, and declared as such**: every change to a disk goes
/// through this.
///
/// What it makes measurable: a transaction interrupted at a chosen moment. A
/// test provides an implementation that fails the n-th step, and the rollback
/// is then exercised at a point of the sequence rather than at a moment of a
/// process nothing deterministic schedules.
///
/// What it costs: this indirection is itself code, and a seam the production
/// path does not go through would be code nobody measures. [`OnDisk`] is the
/// only implementation the product uses, and the nominal tests go through it.
pub trait Steps {
    /// Carries one step out.
    fn carry_out(&self, effect: &Effect) -> Result<(), StepError>;
}

/// The steps, on a real disk. **The only implementation the product uses.**
#[derive(Debug, Clone, Copy)]
pub struct OnDisk;

impl Steps for OnDisk {
    fn carry_out(&self, effect: &Effect) -> Result<(), StepError> {
        match effect {
            Effect::Create { address, contents } => {
                refuse_if_present(address)?;
                write_new(address, contents)
            }
            Effect::Write {
                address,
                contents,
                expected,
            } => {
                let staged = stage(address, contents).map_err(StepError::Txn)?;
                staged
                    .commit(&Fingerprint::of(expected.as_bytes()))
                    .map_err(StepError::Txn)
            }
            Effect::Materialise { address, contents } => match present(address)? {
                None => write_new(address, contents),
                Some(Seized::Document { contents: held, .. }) if held == *contents => Ok(()),
                Some(_) => Err(StepError::StoreConflict {
                    address: address.clone(),
                }),
            },
            Effect::Link { address, to } => {
                refuse_if_present(address)?;
                require_directory(address)?;
                make_link(to, address).map_err(|detail| StepError::Io {
                    address: address.clone(),
                    detail,
                })
            }
            Effect::Unlink { address, to } => match present(address)? {
                Some(Seized::Link { to: held, .. }) if held == *to => take_away(address),
                _ => Err(StepError::NotAsRecorded {
                    address: address.clone(),
                    recorded: format!("a link designating {}", to.display()),
                }),
            },
            Effect::Discard { address, same_as } => {
                let posed = match present(same_as)? {
                    Some(Seized::Document { contents, .. }) => contents,
                    _ => {
                        return Err(StepError::NotAsRecorded {
                            address: same_as.clone(),
                            recorded: "the materialisation this copy was made from".to_string(),
                        })
                    }
                };
                match present(address)? {
                    Some(Seized::Document { contents, .. }) if contents == posed => {
                        take_away(address)
                    }
                    _ => Err(StepError::NotAsRecorded {
                        address: address.clone(),
                        recorded: format!("a copy of {}", same_as.display()),
                    }),
                }
            }
            Effect::Remove { address } => take_away(address),
            Effect::Restore { seized } => match seized {
                Seized::Absent { address } => take_away(address),
                Seized::Document { address, contents } => {
                    take_away(address)?;
                    write_new(address, contents)
                }
                Seized::Link { address, to } => {
                    take_away(address)?;
                    require_directory(address)?;
                    make_link(to, address).map_err(|detail| StepError::Io {
                        address: address.clone(),
                        detail,
                    })
                }
            },
        }
    }
}

/// What is at `address` right now, or `None` when there is nothing.
///
/// **The link itself, never what it designates.** Following it would report the
/// state of the store entry as the state of the address, and a rollback would
/// then give back the wrong thing at both.
fn present(address: &Path) -> Result<Option<Seized>, StepError> {
    let metadata = match fs::symlink_metadata(address) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(detail) => {
            return Err(StepError::Io {
                address: address.to_path_buf(),
                detail,
            })
        }
    };
    if metadata.file_type().is_symlink() {
        let to = fs::read_link(address).map_err(|detail| StepError::Io {
            address: address.to_path_buf(),
            detail,
        })?;
        return Ok(Some(Seized::Link {
            address: address.to_path_buf(),
            to,
        }));
    }
    if metadata.is_dir() {
        return Err(StepError::Io {
            address: address.to_path_buf(),
            detail: io::Error::other("this is a directory, and the product poses files"),
        });
    }
    let bytes = fs::read(address).map_err(|detail| StepError::Io {
        address: address.to_path_buf(),
        detail,
    })?;
    let contents = String::from_utf8(bytes).map_err(|_| StepError::NotUtf8 {
        address: address.to_path_buf(),
    })?;
    Ok(Some(Seized::Document {
        address: address.to_path_buf(),
        contents,
    }))
}

/// Refuses when anything at all is at `address`.
fn refuse_if_present(address: &Path) -> Result<(), StepError> {
    match present(address)? {
        None => Ok(()),
        Some(_) => Err(StepError::Occupied {
            address: address.to_path_buf(),
        }),
    }
}

/// Refuses when the directory the address lives in is not there.
fn require_directory(address: &Path) -> Result<(), StepError> {
    let directory = address.parent().unwrap_or_else(|| Path::new("."));
    if directory.as_os_str().is_empty() || directory.is_dir() {
        return Ok(());
    }
    Err(StepError::NoDirectory {
        address: address.to_path_buf(),
        directory: directory.to_path_buf(),
    })
}

/// Writes `contents` at an address nothing is at, through a temporary in the
/// same directory and a rename — so no reader ever sees half of it.
fn write_new(address: &Path, contents: &str) -> Result<(), StepError> {
    require_directory(address)?;
    let directory = address.parent().unwrap_or_else(|| Path::new("."));
    let name = address
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "artefact".to_string());
    let temporary = directory.join(format!(".{name}.rigger-{}.tmp", std::process::id()));
    let failed = |detail: io::Error| StepError::Io {
        address: address.to_path_buf(),
        detail,
    };
    fs::write(&temporary, contents).map_err(failed)?;
    if let Err(detail) = fs::rename(&temporary, address) {
        let _ = fs::remove_file(&temporary);
        return Err(failed(detail));
    }
    Ok(())
}

/// Leaves nothing at `address`. Already nothing there is success: absence is
/// what this is for, and it is reached.
fn take_away(address: &Path) -> Result<(), StepError> {
    match fs::symlink_metadata(address) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(detail) => Err(StepError::Io {
            address: address.to_path_buf(),
            detail,
        }),
        Ok(_) => fs::remove_file(address).map_err(|detail| StepError::Io {
            address: address.to_path_buf(),
            detail,
        }),
    }
}

/// Makes a symbolic link at `address` designating `to`.
#[cfg(unix)]
fn make_link(to: &Path, address: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(to, address)
}

/// Makes a symbolic link at `address` designating `to`.
///
/// The file flavour, because what is posed is a file. Machines that do not
/// grant the privilege report it here, and the caller poses a copy instead —
/// which is a decision it makes and the trace records, never a fallback taken
/// silently.
#[cfg(windows)]
fn make_link(to: &Path, address: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(to, address)
}

/// Makes a symbolic link at `address` designating `to`.
#[cfg(not(any(unix, windows)))]
fn make_link(_to: &Path, address: &Path) -> io::Result<()> {
    Err(io::Error::other(format!(
        "{}: this build knows no way to make a symbolic link on this system — pose a copy instead",
        address.display()
    )))
}

/// Why a pose or a removal did not happen.
#[derive(Debug)]
pub enum PoseError {
    /// The behaviour refused. Nothing was carried out.
    Refused(BehaviourError),
    /// A step touches an address the capture did not name. Nothing was carried
    /// out: a rollback would have had nothing to give back there.
    Undeclared {
        /// The member of the closed set.
        behaviour: BehaviourName,
        /// The address it would have changed without seizing it.
        address: PathBuf,
    },
    /// The state of an address could not be seized, before anything was
    /// changed.
    NotSeized {
        /// What went wrong.
        detail: StepError,
    },
    /// A step failed, and everything the capture seized was given back. **The
    /// machine is as it was.**
    RolledBack {
        /// Which step, counting from zero.
        step: usize,
        /// What went wrong.
        failure: StepError,
    },
    /// A step failed **and the restoration failed too**.
    ///
    /// It names the restoration and not the capture, because they are two
    /// distinct invariants and only one of them is broken here — the state was
    /// seized, and it is still held: [`PoseError::captured`] gives it back to a
    /// caller that wants to try again. Folding the two into one failure would
    /// leave that reader unable to tell a machine whose state was never taken
    /// from one whose state is taken and waiting.
    NotRestored {
        /// Which step failed, counting from zero.
        step: usize,
        /// What went wrong at that step.
        failure: StepError,
        /// What went wrong while giving the seized state back.
        ///
        /// Boxed, with the capture beside it: this is the one variant that
        /// carries three payloads, and a refusal returned on every path of this
        /// module would otherwise be as wide as its rarest case.
        restoring: Box<StepError>,
        /// The state that was seized, still available.
        captured: Box<Captured>,
    },
}

impl PoseError {
    /// The seized state, when the failure left it held rather than given back.
    pub fn captured(&self) -> Option<&Captured> {
        match self {
            Self::NotRestored { captured, .. } => Some(captured),
            _ => None,
        }
    }
}

impl fmt::Display for PoseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(err) => write!(f, "{err}"),
            Self::Undeclared { behaviour, address } => write!(
                f,
                "behaviour `{behaviour}` would change {} without having seized what is there — \
                 nothing was carried out, because a rollback would have had nothing to give back",
                address.display()
            ),
            Self::NotSeized { detail } => write!(
                f,
                "the state of what is about to change could not be seized, and nothing was \
                 changed — {detail}"
            ),
            Self::RolledBack { step, failure } => write!(
                f,
                "step {step} failed and the machine was given back the state it was in — {failure}"
            ),
            Self::NotRestored {
                step,
                failure,
                restoring,
                ..
            } => write!(
                f,
                "step {step} failed, and giving the seized state back failed as well — the state \
                 was seized and is still held. The step: {failure}. The restoration: {restoring}"
            ),
        }
    }
}

impl std::error::Error for PoseError {}

/// What a pose leaves behind for the registry to record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posted {
    /// What undoes it.
    pub trace: Trace,
    /// The fingerprint of the bytes that were posed.
    pub fingerprint: Digest,
    /// The trace as the registry writes it — obtained **before** anything was
    /// changed. A pose whose trace the registry could not hold does not happen.
    pub record: Vec<String>,
}

/// Poses one thing, under the transaction.
///
/// The order is the whole of it: the address is read, the behaviour computes
/// its steps and its trace, **the trace is put in the form the registry
/// records** — and only then does anything change on the disk. A pose the
/// registry could not describe is a thing nothing could ever remove, and it is
/// refused before it happens rather than discovered afterwards.
pub fn pose(
    name: BehaviourName,
    address: &Path,
    fragment: &Fragment,
    steps: &dyn Steps,
) -> Result<Posted, PoseError> {
    let served = behaviour(name);
    let observed = read_document(address)?;
    let posed = served
        .pose(
            Subject {
                address,
                observed: observed.as_deref(),
            },
            fragment,
        )
        .map_err(PoseError::Refused)?;
    let record = record(&posed.trace).map_err(PoseError::Refused)?;
    carry(served, &posed.effects, steps)?;
    Ok(Posted {
        trace: posed.trace,
        fingerprint: posed.fingerprint,
        record,
    })
}

/// Takes one thing back off, by **replaying its recorded trace**.
///
/// Nothing here looks at the machine to work out what was posed. The trace says
/// what is there, and each step carries the condition that it still be that:
/// anything else is left alone and named. That is the decision the whole model
/// rests on — the archived implementation ended its recognition of shapes on a
/// return that said nothing, which made a posed thing unremovable with no error
/// at all.
pub fn withdraw(
    name: BehaviourName,
    address: &Path,
    trace: &Trace,
    referents: Referents,
    steps: &dyn Steps,
) -> Result<(), PoseError> {
    let served = behaviour(name);
    let observed = read_document(address)?;
    let undone = served
        .undo(
            Subject {
                address,
                observed: observed.as_deref(),
            },
            trace,
            referents,
        )
        .map_err(PoseError::Refused)?;
    carry(served, &undone.effects, steps)
}

/// Carries a list of steps out, seizing first and giving back on failure.
///
/// Public because a behaviour declared outside this workspace — which is how
/// the under-declaration guard below is exercised at all — has no other way in.
pub fn carry(
    served: &dyn Behaviour,
    effects: &[Effect],
    steps: &dyn Steps,
) -> Result<(), PoseError> {
    let named = served.capture(effects).map_err(PoseError::Refused)?;
    for effect in effects {
        if !named.iter().any(|address| address == effect.address()) {
            return Err(PoseError::Undeclared {
                behaviour: served.name(),
                address: effect.address().to_path_buf(),
            });
        }
    }

    let mut seized = Vec::with_capacity(named.len());
    for address in &named {
        let state = present(address)
            .map_err(|detail| PoseError::NotSeized { detail })?
            .unwrap_or_else(|| Seized::Absent {
                address: address.clone(),
            });
        seized.push(state);
    }
    let captured = Captured::of(seized);

    for (step, effect) in effects.iter().enumerate() {
        let Err(failure) = steps.carry_out(effect) else {
            continue;
        };
        let restoration = served.restore(&captured).map_err(PoseError::Refused)?;
        for giving in &restoration.effects {
            if let Err(restoring) = steps.carry_out(giving) {
                return Err(PoseError::NotRestored {
                    step,
                    failure,
                    restoring: Box::new(restoring),
                    captured: Box::new(captured),
                });
            }
        }
        return Err(PoseError::RolledBack { step, failure });
    }
    Ok(())
}

/// The document at `address`, or `None` when there is nothing there.
///
/// One read, and it is the one a pose is conditioned on: reading again later to
/// obtain what the write compares against would reopen the window the
/// conditional write exists to close.
fn read_document(address: &Path) -> Result<Option<String>, PoseError> {
    match fs::read(address) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(contents) => Ok(Some(contents)),
            Err(_) => Err(PoseError::NotSeized {
                detail: StepError::NotUtf8 {
                    address: address.to_path_buf(),
                },
            }),
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(detail) => Err(PoseError::NotSeized {
            detail: StepError::Io {
                address: address.to_path_buf(),
                detail,
            },
        }),
    }
}
