//! The **closed set of behaviours**: the four, and only four, ways this product
//! knows how to put something on a machine and take it back off.
//!
//! Pose a file by link out of a shared store, merge a fragment into a document
//! its owner also writes, delegate the pose to a mechanism of the host, observe
//! a presence and write nothing. A catalogue **names** one of them; it never
//! invents one. A name outside the four is refused by naming it, because a
//! behaviour the product cannot resolve is an inverse it cannot compute, and a
//! thing posed whose inverse cannot be computed is permanently unremovable —
//! with no error and nobody noticing.
//!
//! **A behaviour is a quadruplet**: grammar, inverse, capture, restoration.
//! The last two are not decoration. A compensation written per kind of
//! operation only ever restored **fresh** poses: an update interrupted on an
//! entry that was already there gave back nothing, the disk kept the new
//! version, the registry kept the old one, and the diagnostic reported
//! `modified` on something its owner had never touched. A behaviour that cannot
//! seize the state it changes and give it back **cannot enter a transaction
//! whose rollback is promised**.
//!
//! **This crate is pure.** It reads no file and writes none: what it is handed
//! is what somebody else read, and what it returns is what somebody else
//! writes. That is not tidiness — it is what lets a capture and a restoration
//! be exercised as values, with no disk, no ordering and no interruption to
//! stage.
//!
//! **One behaviour has a body today: `merge`.** The other three refuse by
//! naming themselves. A refusal is not a hole: it names the member, it says
//! that nothing was posed and nothing was undone, and it is written out in each
//! implementation rather than inherited from a default — a default body on this
//! contract is precisely the thing [`Behaviour`] exists to make impossible.

use std::fmt;
use std::path::{Path, PathBuf};

use rigger_grammar::{merge, Edit, Inverse, Jsonc, MergeError, Toml};

/// The name of a member of the closed set. **This enumeration is the closure.**
///
/// A catalogue and a registry trace carry a **name**, never a type: closing the
/// set is therefore something that has to happen where names are turned into
/// members, and that is here. Nothing outside these four parses, so nothing
/// outside these four can ever be selected.
///
/// The set may **shrink** between two versions of the product — that is why the
/// registry records the version that posed each thing. A name that no longer
/// parses is refused by naming it; it is never resolved to a neighbour, and the
/// shape of what was posed is never recognised in order to undo it anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BehaviourName {
    /// Pose a file by link, out of a shared store.
    Link,
    /// Merge a fragment into a document owned by the user.
    Merge,
    /// Delegate the pose to a mechanism of the host.
    Delegate,
    /// Observe a presence, and write nothing.
    Probe,
}

impl BehaviourName {
    /// The members, all of them. The length of this array **is** the size of
    /// the set, and a test pins it: the count is part of what the product
    /// promises, not an implementation detail.
    pub const ALL: [Self; 4] = [Self::Link, Self::Merge, Self::Delegate, Self::Probe];

    /// The name a catalogue writes and a trace records.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Link => "link",
            Self::Merge => "merge",
            Self::Delegate => "delegate",
            Self::Probe => "probe",
        }
    }

    /// The member `named` designates, or a refusal that names what was asked.
    ///
    /// **No fallback, no neighbour, no default.** Trying a member that
    /// resembles the one asked for is the recognition cascade that was removed
    /// from this product: it ended in an undefined return, that is, in a thing
    /// posed that nothing could remove.
    pub fn parse(named: &str) -> Result<Self, BehaviourError> {
        match named {
            "link" => Ok(Self::Link),
            "merge" => Ok(Self::Merge),
            "delegate" => Ok(Self::Delegate),
            "probe" => Ok(Self::Probe),
            _ => Err(BehaviourError::Unknown {
                named: named.to_string(),
            }),
        }
    }
}

impl fmt::Display for BehaviourName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The implementation of the quadruplet that serves each member of the set.
///
/// **This is the second lock, and it is in series with the first.** The match
/// is exhaustive, so a variant added to [`BehaviourName`] does not build until
/// this function can name a type for it — and that type does not build until it
/// declares the four methods of [`Behaviour`], capture and restoration
/// included. Adding a member to the closed set without its capture is therefore
/// not a state this crate can be brought into.
pub fn behaviour(name: BehaviourName) -> &'static dyn Behaviour {
    match name {
        BehaviourName::Link => &Link,
        BehaviourName::Merge => &Merge,
        BehaviourName::Delegate => &Delegate,
        BehaviourName::Probe => &Probe,
    }
}

/// The grammar a behaviour writes through — the **first** element of the
/// quadruplet, and the reason a trace reads `merge/jsonc` rather than `merge`.
///
/// **Named by the catalogue and by the trace, never inferred from the
/// document.** Recognising the shape of what was posed in order to undo it
/// anyway is the cascade this product removed; trying a second grammar because
/// the first one is gone is the same defect wearing a different name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GrammarName {
    /// JSONC, which also serves strict JSON — the settings documents.
    Jsonc,
    /// TOML, read-only. A `merge` declared on it is refused by naming it.
    Toml,
}

impl GrammarName {
    /// The name a catalogue writes and a trace records.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jsonc => "jsonc",
            Self::Toml => "toml",
        }
    }
}

impl fmt::Display for GrammarName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a behaviour acts, and what the caller **read** there.
///
/// `observed` is `None` when nothing is at the address. The read happened
/// elsewhere: this crate is handed its result so that a capture can be measured
/// without a disk.
#[derive(Debug, Clone, Copy)]
pub struct Subject<'a> {
    /// The address the behaviour acts at, as its owner would recognise it.
    pub address: &'a Path,
    /// What was read there, or `None` when there was nothing to read.
    pub observed: Option<&'a str>,
}

/// What a catalogue publishes for one thing to pose.
///
/// One shape today, because one member of the set has a body today. `link` and
/// `delegate` add theirs when they are built; the variant they add is what
/// makes their `pose` able to mean something, and until then their refusal is
/// the honest answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fragment {
    /// An edit expressed in the structure of a named grammar.
    Grammar {
        /// The grammar the edit is written against.
        grammar: GrammarName,
        /// What to write.
        edit: Edit,
    },
}

/// What the registry records so that a pose can be undone by **replaying** it,
/// never by recognising shapes on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trace {
    /// An edit to be undone through a named grammar.
    Grammar {
        /// The grammar the pose was written through.
        grammar: GrammarName,
        /// What undoes it.
        inverse: Inverse,
    },
}

/// What a pose produces: the bytes to write, and the trace that undoes them.
///
/// The two come out of the **same** computation, and that is the point: a trace
/// derived afterwards from what is on disk would describe a document nobody
/// promised had stayed put.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posed {
    /// The bytes to write at the address of the subject.
    pub contents: String,
    /// What undoes this pose, in the form the registry records.
    pub trace: Trace,
}

/// What replaying a trace backwards produces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Undone {
    /// The bytes to write at the address of the subject.
    pub contents: String,
}

/// The state a behaviour seized **before** it changed anything.
///
/// It carries the previous state itself, and not the fact that there was one.
/// The distinction is the whole of the requirement: a flag saying "this pose
/// was fresh" restores an absence and nothing else, so an update interrupted on
/// an entry already present gives back nothing at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Captured {
    /// Nothing was at the address.
    Absent {
        /// The address.
        address: PathBuf,
    },
    /// A document was at the address, carrying these bytes.
    Document {
        /// The address.
        address: PathBuf,
        /// The bytes it carried, whole.
        contents: String,
    },
}

impl Captured {
    /// The address this capture was taken at.
    pub fn address(&self) -> &Path {
        match self {
            Self::Absent { address } | Self::Document { address, .. } => address,
        }
    }
}

/// What giving a captured state back amounts to. A value, because this crate
/// writes nothing: the caller carries it out, under the same conditional write
/// as any other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Restoration {
    /// Take away what is at the address: there was nothing there before.
    Remove {
        /// The address.
        address: PathBuf,
    },
    /// Put these bytes back at the address.
    Write {
        /// The address.
        address: PathBuf,
        /// The bytes from before, whole.
        contents: String,
    },
}

/// Why a behaviour did nothing. Every variant names the member it concerns, and
/// none of them advises a remedy: a product that states a remedy it cannot
/// itself carry out under backup manufactures the loss it claims to avoid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BehaviourError {
    /// A name the closed set does not contain.
    Unknown {
        /// The name as it was written.
        named: String,
    },
    /// A member of the closed set this version of the product carries no body
    /// for. It is a member — it parses, it is named, it is counted — and it
    /// does nothing.
    NotBuilt {
        /// The member.
        behaviour: BehaviourName,
    },
    /// The behaviour acts on a document, and there is none at the address.
    NoDocument {
        /// The member.
        behaviour: BehaviourName,
        /// The address.
        address: PathBuf,
    },
    /// The grammar refused to read or to write, or the post-condition of the
    /// merge did.
    Merge(MergeError),
}

impl From<MergeError> for BehaviourError {
    fn from(err: MergeError) -> Self {
        Self::Merge(err)
    }
}

impl fmt::Display for BehaviourError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown { named } => write!(
                f,
                "unknown behaviour `{named}`: the set is `link`, `merge`, `delegate`, `probe` and \
                 nothing else — the product computes no inverse for a behaviour it cannot resolve, \
                 and it does not guess a neighbouring one"
            ),
            Self::NotBuilt { behaviour } => write!(
                f,
                "behaviour `{behaviour}`: this version of the product carries no implementation of \
                 it — nothing was posed, nothing was undone"
            ),
            Self::NoDocument { behaviour, address } => write!(
                f,
                "behaviour `{behaviour}`: there is no document at {} — the product writes only \
                 where it has observed existence, never where it has just invented something",
                address.display()
            ),
            Self::Merge(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for BehaviourError {}

/// The contract every member of the closed set satisfies: the quadruplet —
/// **grammar, inverse, capture, restoration**.
///
/// # Why a trait with required methods, and not an enumeration
///
/// A behaviour added to the set **without its capture must fail to build**. Not
/// be caught by a test at run time: a run-time check is discovered by the first
/// user the rollback fails, which is the one place nobody is looking.
///
/// Written as an `enum` whose quadruplet is read in an exhaustive `match`, that
/// property would hold — and it would be **unmeasurable**. Forgetting an arm is
/// already a build error for an unrelated reason, the exhaustiveness check of
/// the language, and nothing then distinguishes the guard from the mechanics of
/// Rust. Worse, no test can add a variant to an enumeration from outside the
/// crate, so no test can exercise the guard at all. A guard nobody can make red
/// is a guard whose state nobody knows.
///
/// Written as a trait whose methods carry **no default body**, the same
/// property becomes a build error attributable to this contract alone, and a
/// `compile_fail` doctest produces it: it defines a behaviour outside the
/// crate, omits `capture`, and demands the refusal. Give [`Behaviour::capture`]
/// a default body and that doctest goes **red**, saying `Test compiled
/// successfully, but it's marked compile_fail`. That is the mutation this pair
/// exists to kill.
///
/// A `compile_fail` alone measures nothing: it goes green on **any**
/// compilation error, a typo included. It has teeth only next to its positive
/// twin — the same code, capture declared, which compiles and runs. Each is
/// below next to that twin, and differs from it by exactly one method.
///
/// # Why leaving this trait implementable does not open the set
///
/// [`BehaviourName`] is what closes the set, and it closes it where closure is
/// needed: a catalogue and a trace carry a **name**, never a type. A name
/// outside the four does not parse, so nothing outside the four can ever be
/// selected, whatever types exist elsewhere.
///
/// Sealing this trait would bolt a door nobody can walk through, and it would
/// cost the whole measurement: the `compile_fail` below would go green because
/// of the seal rather than because of the missing capture, and its positive
/// twin would not compile at all. The pair would then measure nothing — which
/// is the exact defect this crate is shaped to avoid.
///
/// # The trial: one positive twin, two refusals
///
/// The requirement names two elements, capture **and** restoration, so there
/// are two refusals and not one. A single example omitting the capture would
/// leave a default body on the restoration unmeasured, and a state seized that
/// nothing gives back is worth exactly as little as a state never seized.
///
/// A behaviour declared outside this crate, with its four methods. It compiles,
/// and it runs:
///
/// ```
/// use std::path::Path;
///
/// use rigger_plan::{
///     Behaviour, BehaviourError, BehaviourName, Captured, Fragment, Posed, Restoration, Subject,
///     Trace, Undone,
/// };
///
/// struct Outsider;
///
/// impl Behaviour for Outsider {
///     fn name(&self) -> BehaviourName {
///         BehaviourName::Probe
///     }
///     fn pose(&self, _: Subject<'_>, _: &Fragment) -> Result<Posed, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn undo(&self, _: Subject<'_>, _: &Trace) -> Result<Undone, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn capture(&self, subject: Subject<'_>) -> Result<Captured, BehaviourError> {
///         Ok(Captured::Absent { address: subject.address.to_path_buf() })
///     }
///     fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError> {
///         Ok(Restoration::Remove { address: captured.address().to_path_buf() })
///     }
/// }
///
/// let subject = Subject { address: Path::new("settings.json"), observed: None };
/// assert_eq!(
///     Outsider.capture(subject).unwrap(),
///     Captured::Absent { address: Path::new("settings.json").to_path_buf() }
/// );
/// ```
///
/// The same behaviour with `capture` left out. It does not compile, and that is
/// the requirement:
///
/// ```compile_fail
/// use std::path::Path;
///
/// use rigger_plan::{
///     Behaviour, BehaviourError, BehaviourName, Captured, Fragment, Posed, Restoration, Subject,
///     Trace, Undone,
/// };
///
/// struct Outsider;
///
/// impl Behaviour for Outsider {
///     fn name(&self) -> BehaviourName {
///         BehaviourName::Probe
///     }
///     fn pose(&self, _: Subject<'_>, _: &Fragment) -> Result<Posed, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn undo(&self, _: Subject<'_>, _: &Trace) -> Result<Undone, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError> {
///         Ok(Restoration::Remove { address: captured.address().to_path_buf() })
///     }
/// }
///
/// let subject = Subject { address: Path::new("settings.json"), observed: None };
/// assert_eq!(
///     Outsider.capture(subject).unwrap(),
///     Captured::Absent { address: Path::new("settings.json").to_path_buf() }
/// );
/// ```
///
/// The same behaviour with `restore` left out. It does not compile either — a
/// capture nothing gives back does not make a rollback:
///
/// ```compile_fail
/// use std::path::Path;
///
/// use rigger_plan::{
///     Behaviour, BehaviourError, BehaviourName, Captured, Fragment, Posed, Restoration, Subject,
///     Trace, Undone,
/// };
///
/// struct Outsider;
///
/// impl Behaviour for Outsider {
///     fn name(&self) -> BehaviourName {
///         BehaviourName::Probe
///     }
///     fn pose(&self, _: Subject<'_>, _: &Fragment) -> Result<Posed, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn undo(&self, _: Subject<'_>, _: &Trace) -> Result<Undone, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn capture(&self, subject: Subject<'_>) -> Result<Captured, BehaviourError> {
///         Ok(Captured::Absent { address: subject.address.to_path_buf() })
///     }
/// }
///
/// let subject = Subject { address: Path::new("settings.json"), observed: None };
/// assert_eq!(
///     Outsider.capture(subject).unwrap(),
///     Captured::Absent { address: Path::new("settings.json").to_path_buf() }
/// );
/// ```
pub trait Behaviour {
    /// The member of the closed set this implementation serves.
    fn name(&self) -> BehaviourName;

    /// **The grammar.** Computes what to write and the trace that undoes it,
    /// out of one and the same reading of the subject.
    fn pose(&self, subject: Subject<'_>, fragment: &Fragment) -> Result<Posed, BehaviourError>;

    /// **The inverse.** Replays a recorded trace backwards, and returns the
    /// document as it stands once it has been. Never a recognition of shapes:
    /// the trace is the only link between a pose and its undoing.
    fn undo(&self, subject: Subject<'_>, trace: &Trace) -> Result<Undone, BehaviourError>;

    /// **The capture.** Seizes the state the pose is about to change, whole and
    /// as it stands, before anything is written.
    ///
    /// It has no default body, and that is the requirement rather than a style:
    /// a behaviour that cannot seize what it changes cannot give it back, so it
    /// cannot enter a transaction whose rollback is promised. See the examples
    /// on this trait — the second of them is this sentence, checked by the
    /// compiler.
    fn capture(&self, subject: Subject<'_>) -> Result<Captured, BehaviourError>;

    /// **The restoration.** Says what giving a captured state back amounts to.
    ///
    /// It is separate from [`Behaviour::undo`], and the two are not
    /// interchangeable. Undoing replays the trace of a **completed** pose;
    /// restoring gives back a state seized before a pose that did not complete.
    /// A transaction interrupted between the two has no trace to replay, and it
    /// is precisely then that the capture is all there is.
    fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError>;
}

/// The refusal of a member of the set this version carries no body for.
///
/// It is written out by each such member rather than inherited from a default
/// on [`Behaviour`]: a default body is exactly what the contract must not have,
/// and a helper that returns a value is not one.
fn not_built<T>(behaviour: BehaviourName) -> Result<T, BehaviourError> {
    Err(BehaviourError::NotBuilt { behaviour })
}

/// Pose a file by link, out of a shared store. **No body in this version.**
///
/// What it will have to do, and what decides its shape rather than its schedule:
/// its removal of a store entry that has lost its last referent must go through
/// the capture of the quadruplet, and never through a direct path that deletes
/// as soon as a reference count reaches zero. With that second path, a rollback
/// has nothing to give back, and no amount of test added later recovers it.
pub struct Link;

impl Behaviour for Link {
    fn name(&self) -> BehaviourName {
        BehaviourName::Link
    }

    fn pose(&self, _subject: Subject<'_>, _fragment: &Fragment) -> Result<Posed, BehaviourError> {
        not_built(BehaviourName::Link)
    }

    fn undo(&self, _subject: Subject<'_>, _trace: &Trace) -> Result<Undone, BehaviourError> {
        not_built(BehaviourName::Link)
    }

    fn capture(&self, _subject: Subject<'_>) -> Result<Captured, BehaviourError> {
        not_built(BehaviourName::Link)
    }

    fn restore(&self, _captured: &Captured) -> Result<Restoration, BehaviourError> {
        not_built(BehaviourName::Link)
    }
}

/// Merge a fragment into a document owned by the user. **The one member with a
/// body in this version.**
///
/// The pose delegates to the merge of the grammar crate, which carries the
/// admission gate, the edit and the post-condition — including the half of it
/// that runs the computed trace backwards and demands the bytes from before.
/// Nothing of that is re-decided here: this member's own substance is the
/// quadruplet, and its capture is the whole document.
pub struct Merge;

impl Behaviour for Merge {
    fn name(&self) -> BehaviourName {
        BehaviourName::Merge
    }

    fn pose(&self, subject: Subject<'_>, fragment: &Fragment) -> Result<Posed, BehaviourError> {
        let Fragment::Grammar { grammar, edit } = fragment;
        let source = self.document(subject)?;
        let merged = match grammar {
            GrammarName::Jsonc => merge::<Jsonc>(source, edit),
            // Read-only, and refused by naming itself. The refusal comes from
            // the admission gate of the grammar crate, so this arm carries no
            // decision of its own — writing the refusal here would be a second
            // definition of it, and two definitions drift.
            GrammarName::Toml => merge::<Toml>(source, edit),
        }?;
        Ok(Posed {
            contents: merged.rendered,
            trace: Trace::Grammar {
                grammar: *grammar,
                inverse: merged.inverse,
            },
        })
    }

    fn undo(&self, subject: Subject<'_>, trace: &Trace) -> Result<Undone, BehaviourError> {
        use rigger_grammar::Grammar;

        let Trace::Grammar { grammar, inverse } = trace;
        let source = self.document(subject)?;
        let contents = match grammar {
            GrammarName::Jsonc => Jsonc::invert(source, inverse),
            GrammarName::Toml => Toml::invert(source, inverse),
        }
        .map_err(|err| BehaviourError::Merge(MergeError::Grammar(err)))?;
        Ok(Undone { contents })
    }

    /// The **whole** document, and not the fact that there was one.
    ///
    /// A capture that recorded only presence restores an absence and nothing
    /// else: an update interrupted on an entry already present would then give
    /// back nothing, leaving the disk on the new version and the registry on
    /// the old one. That is the failure this element of the quadruplet was
    /// added to close, and seizing the bytes is what closes it.
    fn capture(&self, subject: Subject<'_>) -> Result<Captured, BehaviourError> {
        Ok(match subject.observed {
            Some(contents) => Captured::Document {
                address: subject.address.to_path_buf(),
                contents: contents.to_string(),
            },
            None => Captured::Absent {
                address: subject.address.to_path_buf(),
            },
        })
    }

    fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError> {
        Ok(match captured {
            Captured::Document { address, contents } => Restoration::Write {
                address: address.clone(),
                contents: contents.clone(),
            },
            Captured::Absent { address } => Restoration::Remove {
                address: address.clone(),
            },
        })
    }
}

impl Merge {
    /// The document at the address, or a refusal that names the address.
    ///
    /// Merging into nothing would mean fabricating the document, which is the
    /// one thing this product refuses to do to a directory somebody else owns.
    fn document<'a>(&self, subject: Subject<'a>) -> Result<&'a str, BehaviourError> {
        subject.observed.ok_or_else(|| BehaviourError::NoDocument {
            behaviour: BehaviourName::Merge,
            address: subject.address.to_path_buf(),
        })
    }
}

/// Delegate the pose to a mechanism of the host. **No body in this version.**
///
/// What decides its shape rather than its schedule: the result of a delegated
/// undo is a verdict with **three** values — undone, residual, failed — and
/// never a boolean. When the declared inverse command cannot be run, the entry
/// is reported residual by naming what is left, and never as removed. A boolean
/// makes that lie expressible, and one day somebody expresses it.
pub struct Delegate;

impl Behaviour for Delegate {
    fn name(&self) -> BehaviourName {
        BehaviourName::Delegate
    }

    fn pose(&self, _subject: Subject<'_>, _fragment: &Fragment) -> Result<Posed, BehaviourError> {
        not_built(BehaviourName::Delegate)
    }

    fn undo(&self, _subject: Subject<'_>, _trace: &Trace) -> Result<Undone, BehaviourError> {
        not_built(BehaviourName::Delegate)
    }

    fn capture(&self, _subject: Subject<'_>) -> Result<Captured, BehaviourError> {
        not_built(BehaviourName::Delegate)
    }

    fn restore(&self, _captured: &Captured) -> Result<Restoration, BehaviourError> {
        not_built(BehaviourName::Delegate)
    }
}

/// Observe a presence, and write nothing. **No body in this version.**
///
/// It is a member of the set even though it writes nothing, and that is not a
/// formality: observing a presence produces a trace that records a fact without
/// an inverse — the product recognises bytes without thereby acquiring the
/// right to destroy them. A member missing from the set could not carry that
/// distinction, and the entry would have to lie in one direction or the other.
pub struct Probe;

impl Behaviour for Probe {
    fn name(&self) -> BehaviourName {
        BehaviourName::Probe
    }

    fn pose(&self, _subject: Subject<'_>, _fragment: &Fragment) -> Result<Posed, BehaviourError> {
        not_built(BehaviourName::Probe)
    }

    fn undo(&self, _subject: Subject<'_>, _trace: &Trace) -> Result<Undone, BehaviourError> {
        not_built(BehaviourName::Probe)
    }

    fn capture(&self, _subject: Subject<'_>) -> Result<Captured, BehaviourError> {
        not_built(BehaviourName::Probe)
    }

    fn restore(&self, _captured: &Captured) -> Result<Restoration, BehaviourError> {
        not_built(BehaviourName::Probe)
    }
}
