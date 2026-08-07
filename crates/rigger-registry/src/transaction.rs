//! Reading the registry, deciding, and writing it — and the types that make the
//! wrong order of those three impossible to write down.
//!
//! # The window, and what really closes it
//!
//! Two things protect a registry against two runs of the product losing each
//! other's records. The write window holds under an exclusion between processes,
//! and just before writing, the registry is **re-read and the run's mutations
//! replayed onto it** rather than the copy held in memory being written over it.
//!
//! A sequential harness can measure each of them. Take the lock, then demand a
//! second acquisition fail: that kills "the lock is never taken". Write a
//! foreign entry into the registry between the read and the write, then demand
//! it survive: that kills "the copy in memory is written over it".
//!
//! **Neither measurement says the two surround the same window.** Code that
//! re-reads, replays, and takes the lock *afterwards* passes both and loses
//! updates. With one run at a time it produces exactly the file the correct
//! code produces, so no sequential test makes them diverge — and the concurrency
//! that would is a race nothing deterministic schedules.
//!
//! **So the order is carried by the types.** [`Registry::reread`] takes a
//! borrowed proof that the lock is held, and returns a [`Fresh`] that borrows
//! it; [`Fresh::commit`] consumes that and nothing else. The proof is made by
//! acquiring and by nothing else, and dropping it releases the lock. Re-reading
//! before acquiring does not compile, because there is no proof to hand it;
//! releasing before writing does not compile either, because the write borrows
//! the proof. What a race would have had to demonstrate, the compiler refuses.
//!
//! **What that leaves outside, said here rather than tested badly.** The
//! literal scenario — two runs of the product overlapping in time — is a race,
//! and no deterministic test schedules one. A harness that launched two real
//! processes and hoped they overlapped would be red on correct code sometimes
//! and green on broken code often, and making the overlap certain would need a
//! rendezvous point living in the very path that touches a user's documents.
//! The property is held above instead.
//!
//! # What the exclusion does not surround
//!
//! **Not the run.** Consent is asked before the lock is taken, which is why it
//! is a decision handed to [`transact`] rather than a prompt read here: a lock
//! taken around a run would be held for as long as somebody hesitates in front
//! of a question, and the machine would be unusable for that whole time.
//!
//! **Not a read.** [`Registry::read`] takes nothing and writes nothing, so a
//! consultation answers while another run holds the registry.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{Held, LivenessProbe, Lock};

use crate::ledger::{Entry, Identity, Ledger, RegistryError};

/// A change one run makes to the registry.
///
/// They are values rather than writes, which is what lets them be **replayed**
/// onto a registry read again under the lock instead of a copy from before being
/// written over it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mutation {
    /// Record this thing as posed, replacing any record under the same
    /// [`Identity`].
    Upsert(Entry),
    /// Take the record of this thing out.
    Remove {
        /// What names it: the catalogue it came from **and** what that catalogue
        /// called it. Taking one out by name alone would take another
        /// catalogue's entry of that name with it, and nothing else describes
        /// what that one posed.
        identity: Identity,
    },
}

/// Applies the mutations of a run onto a registry, in order.
///
/// Pure, and public for that reason: it is what makes the second stage of the
/// protection something that can be exercised as a value, with no disk and no
/// ordering to stage.
pub fn replay(mutations: &[Mutation], mut ledger: Ledger) -> Ledger {
    for mutation in mutations {
        match mutation {
            Mutation::Upsert(entry) => ledger.upsert(entry.clone()),
            Mutation::Remove { identity } => ledger.remove(identity),
        }
    }
    ledger
}

/// Where a registry lives, and the exclusion that guards it.
///
/// **The location is handed to this type, never looked up by it.** An
/// environment override is read once, at the edge of the command surface, and
/// travels from there as a value. Read at the bottom of the stack instead, it
/// would be a global of the process — which is what the lock would then be
/// derived from, and two registries would share one.
#[derive(Debug, Clone)]
pub struct Registry {
    path: PathBuf,
    lock: Lock,
}

impl Registry {
    /// The registry at this path, and the lock beside it.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let lock = Lock::beside(&path);
        Self { path, lock }
    }

    /// The registry file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The exclusion that guards this registry — derived from its path, so it
    /// follows it when it is relocated.
    pub fn lock(&self) -> &Lock {
        &self.lock
    }

    /// Reads the registry. **Takes nothing, writes nothing.**
    ///
    /// Acquiring here would make a consultation fail while another run writes,
    /// and it would make it wait for a run that is asking its user a question.
    /// Rewriting here — normalising what was read, say — would put this path
    /// among the writers the exclusion exists to order, without it ever having
    /// taken the exclusion.
    ///
    /// A registry that is not there reads as empty: nothing has been posed on
    /// that machine. A registry that is there and does not read is refused, and
    /// the two are kept apart by every arm of [`RegistryError`].
    pub fn read(&self) -> Result<Ledger, RegistryError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Ledger::empty()),
            Err(detail) => {
                return Err(RegistryError::Read {
                    path: self.path.clone(),
                    detail,
                })
            }
        };
        let document = String::from_utf8(bytes).map_err(|_| RegistryError::NotUtf8 {
            path: self.path.clone(),
        })?;
        Ledger::parse(&self.path, &document)
    }

    /// Reads the registry **again, under the lock**, and returns the only value
    /// a write can be made from.
    ///
    /// It takes a borrowed [`Held`] and gives back something that borrows it.
    /// That is the whole guard: this read cannot happen before the lock was
    /// taken, because there would be no proof to pass, and the write that
    /// follows cannot happen after the lock was released, because it holds a
    /// borrow of the proof. The order of the three gestures stops being a
    /// convention somebody could get wrong.
    pub fn reread<'lock>(&self, held: &'lock Held) -> Result<Fresh<'lock>, RegistryError> {
        if held.path() != self.lock.path() {
            return Err(RegistryError::LockElsewhere {
                registry: self.path.clone(),
                expected: self.lock.path().to_path_buf(),
                held: held.path().to_path_buf(),
            });
        }
        Ok(Fresh {
            held,
            path: self.path.clone(),
            ledger: self.read()?,
        })
    }
}

/// The registry as it stands **inside** the write window, and the only thing a
/// write is made from.
///
/// Nothing outside this crate constructs one: it comes from
/// [`Registry::reread`], which needs the proof that the lock is held. Its
/// lifetime is that proof's, so it cannot outlive the exclusion.
#[derive(Debug)]
pub struct Fresh<'lock> {
    /// Held so the exclusion cannot be released while this value is alive. It
    /// is read once, to name the lock in a refusal.
    held: &'lock Held,
    path: PathBuf,
    ledger: Ledger,
}

impl Fresh<'_> {
    /// The registry as it was read under the lock — not as it was read before
    /// the decision.
    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    /// The lock this write is covered by.
    pub fn under(&self) -> &Path {
        self.held.path()
    }

    /// Replays the run's mutations onto what was read under the lock, and writes
    /// the result.
    ///
    /// The replay is onto [`Fresh::ledger`] and never onto a copy read earlier:
    /// an entry another run recorded between the two reads is in this one, and
    /// writing the earlier copy would take it away — the lost update this whole
    /// module is shaped against.
    pub fn commit(self, mutations: &[Mutation]) -> Result<Ledger, RegistryError> {
        let written = replay(mutations, self.ledger);
        write_atomically(&self.path, &written.render())?;
        Ok(written)
    }
}

/// Writes the registry whole, by way of a temporary in its own directory and a
/// rename, so that no reader ever sees half of it.
///
/// It does not go through the conditional write of an owned document, and the
/// difference is the point of that guard rather than an omission. That one
/// exists against a writer the product can neither exclude nor foresee — the
/// host rewriting its own settings file. The registry is the product's own file,
/// nobody else writes it, the exclusion orders the runs that do, and it may not
/// exist yet, which a guard conditioned on what a previous read returned has no
/// answer for.
fn write_atomically(path: &Path, document: &str) -> Result<(), RegistryError> {
    let failed = |detail: std::io::Error| RegistryError::Write {
        path: path.to_path_buf(),
        detail,
    };
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory).map_err(failed)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "registry".to_string());
    let temporary = directory.join(format!(".{name}.rigger-{}.tmp", std::process::id()));
    fs::write(&temporary, document).map_err(failed)?;
    if let Err(detail) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(failed(detail));
    }
    Ok(())
}

/// What the caller decided about a proposed write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Write it.
    Granted,
    /// Do not. This is an answer, and not a failure.
    Refused,
}

/// What the caller is being asked about.
#[derive(Debug)]
pub struct Proposal<'a> {
    /// The registry that would be written.
    pub registry: &'a Path,
    /// The registry as it stood when the proposal was computed.
    pub ledger: &'a Ledger,
    /// What would be changed in it.
    pub mutations: &'a [Mutation],
}

/// **Public surface, and declared as such**: consent is a decision handed to
/// this crate, never a terminal this crate reads.
///
/// What it makes measurable: that the exclusion does not surround the question.
/// A test answers from inside its own implementation and, from there, takes the
/// lock — which succeeds on code that acquires afterwards and fails on code that
/// acquires around the run. Without it, the same observation needs a process
/// stopped on a prompt, a terminal and a second process.
///
/// What it costs: one parameter on [`transact`], and one more contract not to
/// break. What it gives back on the way: this crate cannot read standard input,
/// which is the boundary it should have had anyway — the archived implementation
/// mixed the two, and its engine could block on a question nobody could see.
pub trait Consent {
    /// Whether the product may write this.
    fn decide(&self, proposal: &Proposal<'_>) -> Decision;
}

/// What a transaction came to.
#[derive(Debug)]
pub enum Outcome {
    /// The caller refused. The registry was not touched, and the lock was never
    /// taken.
    Refused {
        /// The registry as it was read.
        ledger: Ledger,
    },
    /// The write happened.
    Committed {
        /// The registry as it now stands.
        ledger: Ledger,
    },
}

/// Reads the registry, asks, and — only then — takes the exclusion, re-reads,
/// replays and writes.
///
/// The order of the last four is not this function's discipline to keep: it is
/// what the types of [`Registry::reread`] and [`Fresh::commit`] allow. What this
/// function decides is the one thing they cannot, which is that the question is
/// asked **before** the lock is taken.
pub fn transact(
    registry: &Registry,
    mutations: &[Mutation],
    consent: &dyn Consent,
    probe: &dyn LivenessProbe,
) -> Result<Outcome, RegistryError> {
    let ledger = registry.read()?;
    let decision = consent.decide(&Proposal {
        registry: registry.path(),
        ledger: &ledger,
        mutations,
    });
    if decision == Decision::Refused {
        return Ok(Outcome::Refused { ledger });
    }

    let held = registry.lock().acquire(probe)?;
    let fresh = registry.reread(&held)?;
    let ledger = fresh.commit(mutations)?;
    Ok(Outcome::Committed { ledger })
}
