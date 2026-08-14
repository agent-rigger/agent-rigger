//! Carrying a behaviour's steps out on a disk, **under a transaction that gives
//! the machine back**.
//!
//! # What the rollback replays, and why that choice covers more
//!
//! Before a single step runs, the transaction **seizes** the state of every
//! address the steps are about to change. If a step fails, it gives every one
//! of those states back, in the reverse order they were changed — and gives
//! nothing back at an address that still carries what was seized, since taking
//! such an address away in order to write it again is a destruction of
//! somebody else's completed pose rather than a restoration of this one.
//!
//! **Every address, including the one a step reaches through a link.** A
//! conditional write renames onto the document a link designates and never onto
//! the link, so the state such a step changes is the document's; seizing the
//! link alone would give back a link nothing had changed while the owner's
//! document kept what a failed run wrote into it, under a failure saying the
//! machine had been given back.
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
    Fragment, Referents, Seized, Subject, Trace, Tree, TreeEntry,
};

use crate::txn::{designated_document, stage, Fingerprint, TxnError};

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
    /// **The product does not make it, and that stays true now that it plants
    /// trees.** What a tree pose creates is exactly one directory — its own
    /// address — and that one is seized as [`Seized::Directory`] and given back
    /// by the restoration. The directories *above* it are somebody else's, they
    /// are not in any capture, and making one would leave behind a change no
    /// removal takes away.
    NoDirectory {
        /// The address.
        address: PathBuf,
        /// The directory that is not there.
        directory: PathBuf,
    },
    /// A symbolic link was found inside a tree the product was about to read.
    ///
    /// **Refused before a single byte is written**, and at any depth. What a
    /// link designates is decided elsewhere and can be moved afterwards, so a
    /// tree carrying one is a tree whose contents the fingerprint does not
    /// describe: the removal would then compare the manifest against something
    /// else than what it posed, and either refuse a tree nobody touched or
    /// delete through the link. The reference catalogue measured on 2026-08-14
    /// holds none — 73 files, no link — which is exactly why this refusal is
    /// writable today and would be unprovable once one existed.
    SymbolicLink {
        /// The link that was found.
        address: PathBuf,
    },
    /// A file of a tree is named in a way that does not stay under the directory
    /// being planted — an absolute name, or one stepping up through `..`.
    ///
    /// The product plants a tree by building it in a transit area, so a name
    /// that escapes would put bytes outside both the transit area and the
    /// address, where nothing seized them and no removal would find them.
    /// Refused before anything is written.
    EscapesTheTree {
        /// The directory being planted.
        address: PathBuf,
        /// The name that does not stay under it.
        name: String,
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
            Self::SymbolicLink { address } => write!(
                f,
                "{}: a tree carrying a symbolic link is refused before anything is written — what \
                 it designates is decided elsewhere and can be moved afterwards, so the \
                 fingerprint of the tree would not describe what the tree holds",
                address.display()
            ),
            Self::EscapesTheTree { address, name } => write!(
                f,
                "{}: the tree names a file `{name}`, which does not stay under it — the product \
                 plants only inside the directory it is about to pose, and nothing was written",
                address.display()
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
///
/// **An implementation reads its own state when the step runs**, whatever that
/// state is kept on — a disk, a store held in memory, nothing at all in a dry
/// run. It is handed one effect and no reading from before, which is the whole
/// of what it has to hold up. The clause that can actually be broken is in
/// [`carry`], which is where a reading from before exists at all.
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
                put(address, contents)
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
                None => put(address, contents),
                Some(Seized::Document { contents: held, .. }) if held == *contents => Ok(()),
                Some(_) => Err(StepError::StoreConflict {
                    address: address.clone(),
                }),
            },
            Effect::Link { address, to } => link_step(to, address, &RealLink),
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
            Effect::Remove { address, posed } => match present(address)? {
                None => Ok(()),
                // **Reads `address` a second time.** `present` just above
                // already read this file's bytes to decide it is a document
                // — then discarded them, keeping only that it is one — and
                // `Measured::of` below reads them again to get a fingerprint
                // to compare. The cost is a few kilobytes of unmeasured text
                // and not the point.
                //
                // The point is what a "fix" must not do: hash the bytes
                // `present` already held instead of calling `Measured::of`
                // here. That would produce a `Digest` claiming disk
                // provenance from a value nothing re-read at comparison
                // time — the exact escape `Measured::of` being this type's
                // sole constructor exists to close. `Measured::of` stays the
                // one call that turns bytes on disk into a `Digest`, even
                // where, as here, its argument was already read a moment
                // ago.
                Some(Seized::Document { .. }) => {
                    if Measured::of(address)?.matches(*posed) {
                        take_away(address)
                    } else {
                        Err(StepError::NotAsRecorded {
                            address: address.clone(),
                            recorded: format!(
                                "the artefact materialised under fingerprint {posed}"
                            ),
                        })
                    }
                }
                Some(_) => Err(StepError::NotAsRecorded {
                    address: address.clone(),
                    recorded: format!("the artefact materialised under fingerprint {posed}"),
                }),
            },
            // **One step for the whole directory**, and the only one that
            // creates a directory at all. Already exactly this tree there and
            // there is nothing to do — the store entry two things ask for is
            // materialised once — while anything else at the address refuses,
            // naming it. `present` reads the tree it finds, so "exactly this
            // tree" is the manifest compared file by file and not a count or a
            // timestamp.
            //
            // **One refusal for both roles, and it is [`StepError::Occupied`]
            // rather than [`StepError::StoreConflict`].** A single file is
            // planted by two different effects — `Create` at the address,
            // `Materialise` in the store — so each can refuse in the words of
            // its own place. One effect serves both here, and it cannot tell
            // them apart: a refusal saying "the shared store already holds this
            // entry" at an address inside somebody's root would send its reader
            // to the wrong directory entirely, while "something is already
            // there and it was left exactly as it is" is true of both.
            Effect::Plant { address, entries } => match present(address)? {
                None => plant(address, entries),
                Some(Seized::Directory { tree, .. }) if tree == *entries => Ok(()),
                Some(_) => Err(StepError::Occupied {
                    address: address.clone(),
                }),
            },
            // Conditioned on the fingerprint of the manifest, which is what
            // makes a tree a user has added a file to refuse instead of being
            // deleted: the product takes back the tree it planted, and a
            // directory that is no longer that tree is left entirely alone and
            // named.
            Effect::Uproot { address, posed } => match present(address)? {
                None => Ok(()),
                Some(Seized::Directory { tree, .. }) if tree.fingerprint() == *posed => {
                    take_away(address)
                }
                Some(Seized::Directory { tree, .. }) => Err(StepError::NotAsRecorded {
                    address: address.clone(),
                    recorded: format!(
                        "the tree planted under fingerprint {posed}, and what is there now holds \
                         {} file(s) fingerprinting as {}",
                        tree.entries().len(),
                        tree.fingerprint()
                    ),
                }),
                Some(_) => Err(StepError::NotAsRecorded {
                    address: address.clone(),
                    recorded: format!("the tree planted under fingerprint {posed}"),
                }),
            },
            Effect::Restore { seized } => restore(seized),
        }
    }
}

/// The primitive `link` actually calls to place a symbolic link — injectable
/// on the pattern [`LinkProbe`] already carries one level up.
///
/// **What [`LinkProbe`] cannot cover.** [`LinkProbe`] answers, before anything
/// runs, whether `link` is practicable in a directory; the refusal it drives
/// is [`PoseError::NotLinkable`], raised before a single byte changes. What it
/// does not cover is the primitive failing **for real, mid-transaction**,
/// after the precondition has already passed — a host that revokes the
/// privilege or remounts the volume between the probe and the write, or,
/// named by the failure register, a volume that serves ordinary files but not
/// links. Manufacturing that on a single disk is not possible: `link_step`
/// below writes into the same directory a copy fallback would write its
/// temporary file through, so any condition that blocks one — a directory
/// made read-only, most concretely — blocks the other identically, and a test
/// built that way cannot distinguish a refusal from a fallback that also
/// failed. `guard_a_link_the_primitive_refuses_leaves_nothing_at_the_address`
/// in `rollback.rs` enters the real primitive and says, in its own doc
/// comment, why it still cannot tell them apart.
///
/// This trait is the seam that removes the filesystem from the question: a
/// test implementation fails deterministically, on a directory that stays
/// otherwise writable, so a copy fallback — if [`link_step`] wrote one — would
/// succeed where a read-only directory would have refused it too.
///
/// What it costs: the same one [`LinkProbe`] already pays. This seam is not on
/// the production path in the sense that no test forces `link_step` to be
/// reached through anything but [`RealLink`] in ordinary use — but `RealLink`
/// calls the exact free function [`make_link`] always called, so the
/// production arm and the injected one run the identical body, only the
/// primitive differing. A mutation inside `link_step` is caught from either
/// caller.
pub trait LinkPrimitive {
    /// Makes a symbolic link at `address` designating `to`.
    fn make_link(&self, to: &Path, address: &Path) -> io::Result<()>;
}

/// The [`LinkPrimitive`] [`OnDisk`] uses when nothing is injected: the same
/// [`make_link`] the crate always called, wrapped so the production path and
/// [`OnDisk::with_link_primitive`] run through the one [`link_step`] rather
/// than two copies of it drifting apart.
struct RealLink;

impl LinkPrimitive for RealLink {
    fn make_link(&self, to: &Path, address: &Path) -> io::Result<()> {
        make_link(to, address)
    }
}

/// The body of [`Effect::Link`], shared by [`OnDisk`]'s own arm and by
/// [`OnDiskWithLinkPrimitive`] — the one function either caller reaches, so
/// what a mutation changes here is caught from both.
fn link_step(to: &Path, address: &Path, primitive: &dyn LinkPrimitive) -> Result<(), StepError> {
    refuse_if_present(address)?;
    require_directory(address)?;
    primitive
        .make_link(to, address)
        .map_err(|detail| StepError::Io {
            address: address.to_path_buf(),
            detail,
        })
}

/// [`OnDisk`], with [`Effect::Link`] carried out through an injected
/// [`LinkPrimitive`] instead of the real symbolic-link syscall.
///
/// Built by [`OnDisk::with_link_primitive`], never directly: the field is
/// private so the only door in names the type it substitutes for, the way
/// [`SystemPracticability`] names [`LinkProbe`]. Every effect other than
/// [`Effect::Link`] is carried out by calling [`OnDisk`] itself, not a second
/// copy of its logic — a step this type did not really carry out on the real
/// disk is a step no scenario built on it measures.
pub struct OnDiskWithLinkPrimitive<'a> {
    link: &'a dyn LinkPrimitive,
}

impl Steps for OnDiskWithLinkPrimitive<'_> {
    fn carry_out(&self, effect: &Effect) -> Result<(), StepError> {
        match effect {
            Effect::Link { address, to } => link_step(to, address, self.link),
            other => OnDisk.carry_out(other),
        }
    }
}

impl OnDisk {
    /// [`OnDisk`], except [`Effect::Link`] asks `link` rather than the
    /// operating system — see [`LinkPrimitive`] for what this makes
    /// measurable and what it costs.
    pub fn with_link_primitive(link: &dyn LinkPrimitive) -> OnDiskWithLinkPrimitive<'_> {
        OnDiskWithLinkPrimitive { link }
    }
}

/// Gives an address back the state a capture seized — and does nothing at all
/// when that state is what is there already.
///
/// **The "does nothing" is the substance, not an economy.** A capture seizes
/// every address the steps are about to change, and some of them turn out
/// unchanged: a pose of an artefact already materialised leaves the store entry
/// exactly as it was, and that entry is in the capture because a step names it.
/// Giving such an address back by taking it away and writing it again removes,
/// for an instant, a materialisation that a pose completed long ago still
/// designates — and destroys it outright if the writing then fails, which is the
/// likely case, the run having already failed once. What the failure would name
/// is the addresses of the run that failed, never the one it destroyed.
fn restore(seized: &Seized) -> Result<(), StepError> {
    if still_as_seized(seized) {
        return Ok(());
    }
    match seized {
        Seized::Absent { address } => take_away(address),
        // **Through the rename alone.** Taking the address away first and
        // writing it again opens an instant in which nothing is there, and
        // leaves nothing at all if the writing then fails — the failure of a
        // restoration being, by definition, the likely case here.
        //
        // No test in this repository goes red on that second form: with one run
        // at a time it produces the same file, and the difference is a window.
        // The property is held by the choice of primitive, as the exchange of
        // the lock is, and not by an assertion.
        Seized::Document { address, contents } => put(address, contents),
        Seized::Link { address, to } => {
            take_away(address)?;
            require_directory(address)?;
            make_link(to, address).map_err(|detail| StepError::Io {
                address: address.clone(),
                detail,
            })
        }
        // **The inverse of creating a directory, which is what was missing.**
        // The tree goes back through the same transit area and the same rename
        // a pose uses, so a restoration that is itself interrupted leaves the
        // address as the failed run left it rather than as a half-rebuilt
        // directory — the failure of a restoration being, by definition, the
        // likely case here.
        Seized::Directory { address, tree } => plant(address, tree),
    }
}

/// Whether what is at the seized address is still the state that was seized.
///
/// **An address this cannot read is not "still as seized".** A state that no
/// longer decodes is a state that has changed as far as anything here can tell,
/// so the restoration is carried out rather than skipped: the error of giving
/// back what was already there is a rewrite, and the error of skipping is a
/// machine left as the failed run made it.
fn still_as_seized(seized: &Seized) -> bool {
    match present(seized.address()) {
        Ok(None) => matches!(seized, Seized::Absent { .. }),
        Ok(Some(now)) => now == *seized,
        Err(_) => false,
    }
}

/// What is at `address` right now, or `None` when there is nothing.
///
/// **The link itself, never what it designates.** Following it would report the
/// state of the store entry as the state of the address, and a rollback would
/// then give back the wrong thing at both.
///
/// What a step writing *through* a link changes is seized as well, and as a
/// second address rather than instead of this one — see [`designated`], and the
/// account at the head of this module.
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
    // **The tree itself, and not the fact that a directory is there.** This is
    // the state [`Seized::Directory`] exists to hold: a capture recording only
    // that something was a directory would give back an empty one, and an empty
    // directory standing where a user's files were is a loss reported as a
    // rollback. Reading it here is also what lets a plant tell "this very tree
    // is already here" from "something else is here".
    if metadata.is_dir() {
        return Ok(Some(Seized::Directory {
            address: address.to_path_buf(),
            tree: read_tree(address)?,
        }));
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

/// A fingerprint **measured on the disk**, and reachable no other way.
///
/// [`Digest`] itself takes any bytes handed to it — a value a catalogue
/// declares, one read back out of a registry line, one a test fabricates — and
/// the reconciliation this product exists to perform compares two of those
/// blindly unless something stops a declared or recorded one from posing as a
/// disk reading. [`Measured::of`] is that stop: the **one** function able to
/// produce a [`Measured`] value, and its body does nothing but `fs::read` the
/// file and hash what it read. There is no second door — the field below is
/// private, there is no `Default`, no `From<Digest>`, and no constructor that
/// takes a [`Digest`] already in hand.
///
/// **What it hands back is a [`Digest`], and nothing else.** No path, no
/// state, no timestamp: a caller putting an entry to conformance gets the one
/// thing this type exists to guarantee the provenance of, and nothing that
/// would let the comparison drift back to a value this type never measured.
///
/// ```compile_fail,E0451
/// use rigger_apply::Measured;
/// use rigger_plan::Digest;
///
/// let digest = Digest::of(b"trust me, this is what's on disk");
/// let _ = Measured { digest };
/// ```
///
/// Its twin, which differs by the one gesture and compiles — without it the
/// refusal above would be indistinguishable from a typo. **A `compile_fail`
/// alone measures nothing: it goes green on any mutation**, and only the pair
/// tells a real refusal from a broken example.
///
/// **The error code on the fence is documentation, not a check — measured, not
/// assumed.** `E0451` is the code this refusal really carries: the block was
/// extracted into a throwaway crate and compiled to read it. But writing a
/// deliberately wrong code on the fence and running `cargo test --doc` on this
/// toolchain leaves the doctest green, so nothing here goes red the day the
/// refusal starts coming from somewhere else. The code is written down so a
/// reader can check it by hand; **what carries the guarantee is the pair**, and
/// the pair alone.
///
/// ```no_run
/// use rigger_apply::Measured;
/// use rigger_plan::Digest;
///
/// let digest = Digest::of(b"trust me, this is what's on disk");
/// let _ = Measured::of(std::path::Path::new("/nowhere/artefact"));
/// ```
///
/// # The comparison this type does not itself close
///
/// [`Measured::of`] guarantees the *left*-hand side of an equality was read
/// from disk just now. Nothing here constrains the *right*-hand side:
/// [`digest`](Measured::digest) hands back a bare [`Digest`], and a bare
/// [`Digest`] compares equal to any other regardless of where it came from —
/// a value a catalogue declares, one read back out of a registry line, or
/// one a test fabricates with [`Digest::of`] compares exactly the way a disk
/// reading does. `digest()` cannot be narrowed or dropped to close that: a
/// diagnostic pass over a registry needs the plain [`Digest`] it hands back,
/// and nothing else, to compare against what was recorded.
///
/// [`matches`](Measured::matches) does not remove the possibility either —
/// `Digest::of(bytes) == recorded` still compiles, and still passes for any
/// `bytes` a caller hands it. What it does is make the correct comparison
/// the one that is shortest to write: `Measured::of(path)?.matches(recorded)`
/// names, in its own signature, that its left-hand side was measured.
#[derive(Debug, Clone, Copy)]
pub struct Measured {
    digest: Digest,
}

impl Measured {
    /// Reads `path` now, and returns the fingerprint of what it holds.
    ///
    /// **This is the read.** Every place in this crate that wants a
    /// [`Measured`] value comes through here, and the `fs::read` lives in this
    /// body and nowhere else that could produce one.
    ///
    /// A path nothing is at refuses rather than answering with the
    /// fingerprint of an empty file: a missing file and an empty one are two
    /// different states, and collapsing them to the same value is exactly
    /// what would let a removal, or a diagnostic, mistake one for the other.
    pub fn of(path: &Path) -> Result<Self, StepError> {
        let bytes = fs::read(path).map_err(|detail| StepError::Io {
            address: path.to_path_buf(),
            detail,
        })?;
        Ok(Self {
            digest: Digest::of(&bytes),
        })
    }

    /// The fingerprint itself — the one thing this type ever gives up.
    pub fn digest(&self) -> Digest {
        self.digest
    }

    /// Whether this measurement's fingerprint is `expected`.
    ///
    /// **The comparison this type exists for.** `self.digest() == expected`
    /// reads the same on the page, but only names the type of the right-hand
    /// side — a caller comparing two bare [`Digest`] values that way never
    /// had to hold a [`Measured`] at all. Written as `matches`, a call site
    /// names the read its receiver depends on: nothing but [`Measured::of`]
    /// produces one, so `some_measured.matches(recorded)` cannot be reached
    /// without a disk read behind `some_measured`, whatever `recorded` is.
    pub fn matches(&self, expected: Digest) -> bool {
        self.digest == expected
    }
}

/// Reads the whole directory at `root` as the tree it holds — **the one way a
/// tree is obtained from a disk.**
///
/// It is public because it is where the source of a tree pose comes from: a
/// caller hands the directory a catalogue publishes, and gets back the value the
/// pure crate computes a pose out of. Nothing is written by then, which is what
/// makes the refusals below refusals *before* any file operation rather than
/// after some.
///
/// **Every entry is `lstat`ed, at every depth, and a symbolic link refuses.**
/// Following one would let a tree's fingerprint describe bytes that live
/// somewhere else and can be repointed afterwards; not following one would put a
/// link in the store that the fingerprint does not cover either. The refusal is
/// the only answer that stays true after the fact — and it can be written today
/// only because no tree the product serves carries a link yet.
///
/// **A file the product cannot hold as text refuses too**, for the reason the
/// capture already refuses one: a tree it cannot give back exactly is a tree it
/// must not take away.
///
/// **An empty directory inside the tree carries nothing and is not kept.** A
/// tree is its files; planting it back reconstructs every directory a file needs
/// and none that no file needs, so an empty one would be a difference the
/// fingerprint cannot express and the plant could not reproduce.
pub fn read_tree(root: &Path) -> Result<Tree, StepError> {
    let mut found = Vec::new();
    read_tree_into(root, root, &mut found)?;
    Ok(Tree::of(found))
}

/// One directory's worth of [`read_tree`], recursing into what it holds.
fn read_tree_into(
    root: &Path,
    directory: &Path,
    found: &mut Vec<TreeEntry>,
) -> Result<(), StepError> {
    let failed = |path: &Path| {
        let path = path.to_path_buf();
        move |detail: io::Error| StepError::Io {
            address: path.clone(),
            detail,
        }
    };
    let listing = fs::read_dir(directory).map_err(failed(directory))?;
    for entry in listing {
        let entry = entry.map_err(failed(directory))?;
        let path = entry.path();
        // `lstat`, and never a walk that follows what it finds: `symlink_metadata`
        // reports the link itself, so the refusal below is reached on a link to a
        // directory as well as on a link to a file.
        let metadata = fs::symlink_metadata(&path).map_err(failed(&path))?;
        if metadata.file_type().is_symlink() {
            return Err(StepError::SymbolicLink { address: path });
        }
        if metadata.is_dir() {
            read_tree_into(root, &path, found)?;
            continue;
        }
        let bytes = fs::read(&path).map_err(failed(&path))?;
        let contents = String::from_utf8(bytes).map_err(|_| StepError::NotUtf8 {
            address: path.clone(),
        })?;
        found.push(TreeEntry {
            name: relative_name(root, &path)?,
            contents,
        });
    }
    Ok(())
}

/// Where `path` sits under `root`, spelled with `/` whatever this machine's
/// separator is — see [`rigger_plan::TreeEntry`] for why the spelling is not the
/// host's.
fn relative_name(root: &Path, path: &Path) -> Result<String, StepError> {
    let under = path.strip_prefix(root).map_err(|_| StepError::Io {
        address: path.to_path_buf(),
        detail: io::Error::other("this is not under the tree being read"),
    })?;
    let mut name = String::new();
    for part in under.components() {
        let spelled = part
            .as_os_str()
            .to_str()
            .ok_or_else(|| StepError::NotUtf8 {
                address: path.to_path_buf(),
            })?;
        if !name.is_empty() {
            name.push('/');
        }
        name.push_str(spelled);
    }
    Ok(name)
}

/// The transit area a tree is built in before it is renamed onto `address`.
///
/// **It sits in the directory the address sits in**, and that is the whole of
/// why the pose is atomic: `rename` does not cross filesystems, so an area
/// anywhere else — a system temporary directory, most obviously — would degrade
/// the rename into a copy and give back exactly the partial directory this
/// design exists to make impossible. It is named after the address, behind a
/// leading dot, and carries the process that is writing it: the residue of an
/// interrupted pose is then visible next to where it would have gone, and says
/// what left it there.
fn transit_area(address: &Path) -> PathBuf {
    let directory = address.parent().unwrap_or_else(|| Path::new("."));
    let name = address
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tree".to_string());
    directory.join(format!(".{name}.rigger-{}.planting", std::process::id()))
}

/// Puts `tree` at `address`, through a transit area beside it and a rename — so
/// no reader ever sees half of it, and an interruption leaves nothing at the
/// address at all.
///
/// **This is the decision ADR-0049 turns on.** A tree written file by file into
/// its final directory is visible while it is incomplete, and its interruption
/// leaves a partial directory that something has to unwind exactly right;
/// written into a transit area and renamed, partial rollback is not a thing that
/// can be got wrong, because there is never a partial state to roll back. The
/// cost is named rather than hidden: an interrupted run leaves the transit area
/// behind, and what that costs is disk space.
///
/// The rename replaces whatever the address carries. Callers that must not
/// replace anything say so themselves, before calling: [`Effect::Plant`] refuses
/// on an address holding anything but this very tree, and it is a different
/// promise from this one.
fn plant(address: &Path, tree: &Tree) -> Result<(), StepError> {
    require_directory(address)?;
    let transit = transit_area(address);
    let failed = |detail: io::Error| StepError::Io {
        address: address.to_path_buf(),
        detail,
    };
    // An area left by an interrupted run under this same process number is the
    // residue this design accepts; it is cleared rather than merged into, so
    // what lands at the address is this tree and never this tree over another.
    let _ = fs::remove_dir_all(&transit);
    let built = build_in_transit(address, &transit, tree);
    if let Err(refusal) = built {
        let _ = fs::remove_dir_all(&transit);
        return Err(refusal);
    }
    if let Err(refusal) = take_away(address) {
        let _ = fs::remove_dir_all(&transit);
        return Err(refusal);
    }
    if let Err(detail) = fs::rename(&transit, address) {
        let _ = fs::remove_dir_all(&transit);
        return Err(failed(detail));
    }
    Ok(())
}

/// Builds the files of `tree` inside the transit area. Every failure leaves the
/// area to its caller, which is what removes it: an area half built is never
/// renamed anywhere.
fn build_in_transit(address: &Path, transit: &Path, tree: &Tree) -> Result<(), StepError> {
    fs::create_dir(transit).map_err(|detail| StepError::Io {
        address: transit.to_path_buf(),
        detail,
    })?;
    for entry in tree.entries() {
        let file = confined(address, transit, &entry.name)?;
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|detail| StepError::Io {
                address: file.clone(),
                detail,
            })?;
        }
        fs::write(&file, &entry.contents).map_err(|detail| StepError::Io {
            address: file.clone(),
            detail,
        })?;
    }
    Ok(())
}

/// Where `name` goes inside the transit area, refusing any name that would not
/// stay under it.
///
/// A name is checked **component by component** rather than searched for `..` as
/// text: a name containing the two characters somewhere inside a filename is
/// legitimate, and one made only of them is not, and the difference is what a
/// substring search gets wrong in both directions.
fn confined(address: &Path, transit: &Path, name: &str) -> Result<PathBuf, StepError> {
    let escapes = |name: &str| StepError::EscapesTheTree {
        address: address.to_path_buf(),
        name: name.to_string(),
    };
    let mut under = transit.to_path_buf();
    let mut parts = 0;
    for part in Path::new(name).components() {
        match part {
            std::path::Component::Normal(part) => {
                under.push(part);
                parts += 1;
            }
            _ => return Err(escapes(name)),
        }
    }
    if parts == 0 {
        return Err(escapes(name));
    }
    Ok(under)
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

/// Puts `contents` at `address`, through a temporary in the same directory and a
/// rename — so no reader ever sees half of it, and there is no instant in which
/// nothing is there.
///
/// The rename replaces whatever the address carries. Callers that must not
/// replace anything say so themselves, before calling: [`Effect::Create`] refuses
/// on an occupied address, and it is a different promise from this one.
fn put(address: &Path, contents: &str) -> Result<(), StepError> {
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
///
/// **A directory goes whole, and a symbolic link to one does not.** The metadata
/// is `lstat`, so a link is a link here however it was made and only its own
/// entry is taken away — following it would delete a directory the product never
/// posed. Every caller has already established its right to what it names: a
/// step under its recorded condition, or a restoration giving back an absence
/// the capture seized.
fn take_away(address: &Path) -> Result<(), StepError> {
    let failed = |detail: io::Error| StepError::Io {
        address: address.to_path_buf(),
        detail,
    };
    match fs::symlink_metadata(address) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(detail) => Err(failed(detail)),
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(address).map_err(failed),
        Ok(_) => fs::remove_file(address).map_err(failed),
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

/// Whether a symbolic link can actually be made inside a directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Practicability {
    /// A symbolic link can be made there.
    Practicable,
    /// It cannot, and the reason is carried rather than discarded: it is what
    /// the refusal has to name.
    NotPracticable {
        /// What the system reported instead of a link.
        reason: String,
    },
}

/// **Public surface, and declared as such**: whether `link` is practicable
/// inside a directory is asked of this rather than assumed, on the pattern of
/// [`crate::lock::LivenessProbe`].
///
/// What it makes measurable: the refusal [`pose`] raises when the directory a
/// pose is about to place a link in cannot actually hold one — a volume
/// formatted without symlink support, a container overlay that refuses them,
/// a host without the privilege. Manufacturing one of those for a test needs
/// a real one of those filesystems, which a portable suite does not have on
/// hand. A test implementation answers `NotPracticable` without touching a
/// filesystem at all, and the refusal this module raises on it is then
/// exercised on every machine the tests run on, not only the rare one where
/// it is true.
///
/// What it costs: one parameter on [`pose`], and the same temptation the
/// liveness probe carries — that the test of the refusal covers the real
/// probe. It does not. Whether [`SystemPracticability`] really answers
/// `NotPracticable` on a volume that refuses a link is a measurement of a
/// machine, and it belongs with the other characterizations of the
/// environment.
pub trait LinkProbe {
    /// Whether a symbolic link can be made inside `directory`.
    fn practicability(&self, directory: &Path) -> Practicability;
}

/// The one implementation that asks the operating system.
///
/// It makes a link through [`make_link`] — the same primitive [`OnDisk`] uses
/// to place one for real — and removes it at once. Asking through a
/// different primitive would answer a question the write does not pose. What
/// is measured is the residue: an attempt leaves nothing behind, on the
/// success path and on the failure path both.
pub struct SystemPracticability;

impl LinkProbe for SystemPracticability {
    fn practicability(&self, directory: &Path) -> Practicability {
        let probe_address = directory.join(format!(".rigger-link-probe.{}", std::process::id()));
        match make_link(Path::new("rigger-link-probe-target"), &probe_address) {
            Ok(()) => {
                let _ = fs::remove_file(&probe_address);
                Practicability::Practicable
            }
            Err(detail) => Practicability::NotPracticable {
                reason: detail.to_string(),
            },
        }
    }
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
    /// `link` is not practicable in the directory a pose is about to place
    /// one in — checked before anything was changed. Nothing was carried
    /// out.
    NotLinkable {
        /// The directory a symbolic link would have been made inside.
        directory: PathBuf,
        /// What the system reported instead of a link.
        reason: String,
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
            Self::NotLinkable { directory, reason } => write!(
                f,
                "{}: a symbolic link cannot be made there — {reason}; nothing was carried out",
                directory.display()
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
#[must_use = "a pose that is not recorded is a thing posed on the disk that nothing can ever take \
              back; hand this to the registry"]
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
/// records**, `link` is asked whether it can actually reach where this pose is
/// about to place one — and only then does anything change on the disk. A
/// pose the registry could not describe is a thing nothing could ever remove,
/// and a pose that cannot actually make the link it promises would otherwise
/// be discovered mid-write, with a rollback to unwind for a condition that
/// held before anything started. Both are refused before they happen rather
/// than discovered afterwards.
///
/// **The thing is on the disk when this returns, and its trace is nowhere
/// yet.** Dropping what comes back does not abandon an intention; it leaves a
/// posed artefact that no removal will ever find, which is the damage this
/// product exists to prevent. The refusal is the compiler's:
///
/// ```compile_fail,unused_must_use
/// #![deny(unused_must_use)]
/// use std::path::{Path, PathBuf};
/// use rigger_apply::{pose, OnDisk, SystemPracticability};
/// use rigger_plan::{BehaviourName, Fragment, Placement};
///
/// let fragment = Fragment::Artefact {
///     store: PathBuf::from("/store/acme-review-1.0"),
///     contents: "# Review\n".to_string(),
///     placement: Placement::Link,
/// };
/// pose(
///     BehaviourName::Link,
///     Path::new("review.md"),
///     &fragment,
///     &OnDisk,
///     &SystemPracticability,
/// )
/// .unwrap();
/// ```
///
/// Its twin, which differs by the one gesture and compiles — without it the
/// refusal above would be indistinguishable from a typo:
///
/// ```no_run
/// use std::path::{Path, PathBuf};
/// use rigger_apply::{pose, OnDisk, SystemPracticability};
/// use rigger_plan::{BehaviourName, Fragment, Placement};
///
/// let fragment = Fragment::Artefact {
///     store: PathBuf::from("/store/acme-review-1.0"),
///     contents: "# Review\n".to_string(),
///     placement: Placement::Link,
/// };
/// let posted = pose(
///     BehaviourName::Link,
///     Path::new("review.md"),
///     &fragment,
///     &OnDisk,
///     &SystemPracticability,
/// )
/// .unwrap();
/// record(posted);
/// # fn record(_: rigger_apply::Posted) {}
/// ```
pub fn pose(
    name: BehaviourName,
    address: &Path,
    fragment: &Fragment,
    steps: &dyn Steps,
    link_probe: &dyn LinkProbe,
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
    require_linkable(&posed.effects, link_probe)?;
    carry(served, &posed.effects, steps)?;
    Ok(Posted {
        trace: posed.trace,
        fingerprint: posed.fingerprint,
        record,
    })
}

/// Refuses when the effects about to be carried out would place a symbolic
/// link somewhere `link` cannot actually reach.
///
/// **It defers to [`StepError::NoDirectory`] rather than duplicate it.** A
/// directory that is not there yet is not this precondition's concern — that
/// refusal is already named, downstream inside [`carry`], by
/// [`require_directory`] — and asking the probe to link inside a directory
/// that was never there would only obtain a less specific reason for the same
/// absence.
fn require_linkable(effects: &[Effect], probe: &dyn LinkProbe) -> Result<(), PoseError> {
    for effect in effects {
        let Effect::Link { address, .. } = effect else {
            continue;
        };
        let directory = address.parent().unwrap_or_else(|| Path::new("."));
        if !directory.is_dir() {
            continue;
        }
        if let Practicability::NotPracticable { reason } = probe.practicability(directory) {
            return Err(PoseError::NotLinkable {
                directory: directory.to_path_buf(),
                reason,
            });
        }
    }
    Ok(())
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
///
/// **B8 — what is seized here is for giving back, and a step never decides on
/// it.** This is the one place the rule can be broken, because this is the one
/// place the seized state exists: `seized` is a local, a scope away from the
/// loop that carries the steps out, and passing it down would spare every
/// removal a read. It would also let [`Effect::Unlink`] take away a link the
/// owner re-pointed after the capture read it, [`Effect::Discard`] a file they
/// rewrote, and [`Effect::Remove`] a store entry that no longer holds what was
/// posed — each of them destroying bytes it never looked at, and reporting
/// success. A removal reads its address when its turn comes, and it acts on that
/// reading.
///
/// What the `b8_` scenarios measure is **which reading a removal acts on**, in
/// both directions an address can diverge from what was seized: absent when the
/// capture ran and carrying something by the time its removal comes, and
/// present at the capture and changed by its owner before the step reaches it.
/// They do not measure that each pre-condition is asked *in full*, and the
/// distinction is worth the sentence: an [`Effect::Unlink`] that still asked
/// whether a link is there but no longer whether it designates what the trace
/// recorded leaves both scenarios green — measured, not supposed. That half is
/// somebody else's to hold.
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

    // **What a step reaches through a link is seized too.** A conditional write
    // renames onto the document a link designates and never onto the link, which
    // is what keeps a settings file linked into a versioned configuration
    // repository from being replaced by an ordinary file. So the state such a
    // step changes is the document's: seizing the link alone would give back a
    // link nothing had changed and leave the owner's document carrying what the
    // failed run wrote into it, under a failure claiming the machine was given
    // back.
    let mut seizing = named.clone();
    for effect in effects {
        if let Effect::Write { address, .. } = effect {
            let document = designated(address).map_err(|detail| PoseError::NotSeized { detail })?;
            if !seizing.contains(&document) {
                seizing.push(document);
            }
        }
    }

    let mut seized = Vec::with_capacity(seizing.len());
    for address in &seizing {
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

/// The document a write at `address` actually replaces: the address itself, or
/// what it designates when it is a symbolic link.
///
/// It is the same walk the staging does, and deliberately the same one: two
/// answers to "which file does this write land in" would drift, and the day they
/// did, the capture would seize one file and the write replace another.
///
/// An address nothing is at designates itself. There is nothing there to seize,
/// and a refusal here would make a pose onto an empty address impossible.
fn designated(address: &Path) -> Result<PathBuf, StepError> {
    match designated_document(address) {
        Ok(document) => Ok(document),
        Err(TxnError::Read { detail, .. }) if detail.kind() == io::ErrorKind::NotFound => {
            Ok(address.to_path_buf())
        }
        Err(err) => Err(StepError::Txn(err)),
    }
}

/// The document at `address`, or `None` when there is no document there.
///
/// One read, and it is the one a pose is conditioned on: reading again later to
/// obtain what the write compares against would reopen the window the
/// conditional write exists to close.
///
/// **A directory carries no document, and answers `None` like an empty address
/// does.** It is not a failure to report: a tree is posed *at* a directory
/// address, and the behaviour that poses it is handed what a caller read there,
/// which for a directory is nothing. The question is asked of the resolved
/// address rather than of the link itself, because a tree posed by link leaves a
/// symbolic link at the address and its removal reads that same address — where
/// a reading that stopped at the link would report "not a directory" and refuse
/// the removal of a tree the product itself planted.
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
        Err(_) if fs::metadata(address).is_ok_and(|what| what.is_dir()) => Ok(None),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(detail) => Err(PoseError::NotSeized {
            detail: StepError::Io {
                address: address.to_path_buf(),
                detail,
            },
        }),
    }
}
