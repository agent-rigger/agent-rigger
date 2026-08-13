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
//! **This crate is pure.** It reads no file and writes none. A pose returns
//! [`Effect`]s — values saying what has to happen on a disk — and the trace that
//! undoes them; somebody else carries them out. That is not tidiness: it is what
//! lets a capture and a restoration be exercised as values, with no disk, no
//! ordering and no interruption to stage.
//!
//! **Two members have a body today: `link` and `merge`.** The other two refuse
//! by naming themselves. A refusal is not a hole: it names the member, it says
//! that nothing was posed and nothing was undone, and it is written out in each
//! implementation rather than inherited from a default — a default body on this
//! contract is precisely the thing [`Behaviour`] exists to make impossible.

use std::fmt;
use std::path::{Path, PathBuf};

use rigger_grammar::{merge, unmerge, Edit, Inverse, Jsonc, MergeError, Toml};

/// Declares the closed set **once**, and derives from that one declaration the
/// three things that must never disagree about it: the members, the written
/// name of each, and the reading of a name back into a member.
///
/// # Why a macro, when three hand-written matches would read the same
///
/// Because they would read the same right up to the day they stopped agreeing.
/// Written by hand, the closure held in **one** direction only: `as_str` and
/// the resolution of bodies are exhaustive matches, so the compiler forced them
/// on a new member — but the reading of a name ended in a catch-all, and the
/// list of members was an array written out by hand. A member could therefore
/// be added to the set whose own name the product refused as unknown, and whom
/// the list of members left out, with the whole suite green.
///
/// What that costs is not an inconsistency in a table. The registry records the
/// **name**: a pose through such a member would succeed and write that name
/// into the trace, and the removal would then refuse — "the product computes no
/// inverse for a behaviour it cannot resolve" — leaving the posed thing
/// permanently unremovable, which is the one damage this crate is shaped
/// against.
///
/// A test cannot close that gap: no test can add a variant to an enumeration,
/// so no test can be red on the omission. Only the declaration can, by making
/// the omission **unwritable** — there is no way to add a member here without
/// giving it, in the same breath, its written name, its place among the
/// members, and its arm in the reading. The exhaustive matches then keep doing
/// their half, and [`behaviour`] still refuses to build until the new member
/// has a body.
///
/// # What this declaration does not close, and what does
///
/// **Two members declared under the same written name.** The declaration
/// accepts it; three other things refuse it, and they are named here rather
/// than left to be rediscovered. The reading becomes an unreachable arm, which
/// the compiler reports and the quality gate denies. And two guards in the
/// tests go red: the one that pins the written names of the set, and the one
/// that demands every member be found again through its own name.
macro_rules! closed_set {
    (@count) => { 0usize };
    (@count $head:ident $($tail:ident)*) => { 1usize + closed_set!(@count $($tail)*) };
    (
        $( #[$set_doc:meta] )*
        pub enum $Name:ident {
            $(
                $( #[$member_doc:meta] )*
                $Member:ident => $written:literal,
            )+
        }
    ) => {
        $( #[$set_doc] )*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $Name {
            $(
                $( #[$member_doc] )*
                $Member,
            )+
        }

        impl $Name {
            /// The members, all of them. The length of this array **is** the
            /// size of the set: it is counted from the declaration above rather
            /// than written down, so it cannot fall behind it.
            pub const ALL: [Self; closed_set!(@count $($Member)+)] = [$(Self::$Member),+];

            /// The name a catalogue writes and a trace records.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$Member => $written,)+
                }
            }

            /// The member `named` designates, or a refusal that names what was
            /// asked.
            ///
            /// **No fallback, no neighbour, no default.** Trying a member that
            /// resembles the one asked for is the recognition cascade that was
            /// removed from this product: it ended in an undefined return, that
            /// is, in a thing posed that nothing could remove.
            ///
            /// The catch-all below refuses; it can no longer **hide** a member,
            /// because the arms above it come from the same declaration as the
            /// members themselves.
            pub fn parse(named: &str) -> Result<Self, BehaviourError> {
                match named {
                    $($written => Ok(Self::$Member),)+
                    _ => Err(BehaviourError::Unknown {
                        named: named.to_string(),
                    }),
                }
            }
        }
    };
}

closed_set! {
    /// The name of a member of the closed set. **This enumeration is the
    /// closure.**
    ///
    /// A catalogue and a registry trace carry a **name**, never a type: closing
    /// the set is therefore something that has to happen where names are turned
    /// into members, and that is here. Nothing outside these four parses, so
    /// nothing outside these four can ever be selected.
    ///
    /// The set may **shrink** between two versions of the product — that is why
    /// the registry records the version that posed each thing. A name that no
    /// longer parses is refused by naming it; it is never resolved to a
    /// neighbour, and the shape of what was posed is never recognised in order
    /// to undo it anyway.
    ///
    /// **A member and its written name are declared together**, and the members
    /// of [`BehaviourName::ALL`] and the arms of [`BehaviourName::parse`] are
    /// derived from that one declaration. Adding a member without its name, or
    /// without its place in the set, is not a state this file can be brought
    /// into: the declaration takes a member and its name together or not at
    /// all. What that omission used to cost is written where the declaration
    /// is made.
    pub enum BehaviourName {
        /// Pose a file by link, out of a shared store.
        Link => "link",
        /// Merge a fragment into a document owned by the user.
        Merge => "merge",
        /// Delegate the pose to a mechanism of the host.
        Delegate => "delegate",
        /// Observe a presence, and write nothing.
        Probe => "probe",
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

/// The fingerprint of the bytes a pose put on a machine.
///
/// # Why the algorithm is written out here and named
///
/// What the registry records has to read back the same under **every later
/// build of the product**. A fingerprint whose algorithm moved would report
/// every entry on a machine as rewritten by somebody else, on the very day the
/// product was updated — and the diagnostic exists precisely to tell "the
/// product wrote this" from "somebody else rewrote it". The hasher of the
/// standard library is documented as free to change between releases, which is
/// that failure with nothing to warn of it.
///
/// This is FNV-1a over 64 bits: offset basis `0xcbf2_9ce4_8422_2325`, prime
/// `0x0000_0100_0000_01b3`, one byte at a time. Naming it is the point — a
/// reader can reimplement it and get the same answer.
///
/// **What it is for, and what it is not.** It tells an accidental rewrite from
/// no rewrite at all. It is not a defence against bytes chosen to collide with
/// it, and nothing here treats it as one: the product never grants a right over
/// a document because a fingerprint matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Digest(u64);

impl Digest {
    /// The offset basis of FNV-1a, 64 bits.
    const BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    /// The prime of FNV-1a, 64 bits.
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    /// The fingerprint of these bytes.
    pub fn of(bytes: &[u8]) -> Self {
        let mut state = Self::BASIS;
        for byte in bytes {
            state ^= u64::from(*byte);
            state = state.wrapping_mul(Self::PRIME);
        }
        Self(state)
    }

    /// The fingerprint `written` spells, or nothing when it is not one this
    /// build writes.
    ///
    /// **Sixteen lowercase hexadecimal digits and nothing else**, which is
    /// exactly what [`Digest`]'s rendering produces. A field read loosely — a
    /// sign accepted, a shorter run of digits padded — would read back as a
    /// fingerprint that was never written, and a removal conditioned on it would
    /// then take away bytes nobody proved were the ones posed.
    pub fn read(written: &str) -> Option<Self> {
        let spelled = written.as_bytes();
        if spelled.len() != 16 {
            return None;
        }
        if !spelled
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return None;
        }
        u64::from_str_radix(written, 16).ok().map(Self)
    }
}

impl fmt::Display for Digest {
    /// Sixteen lowercase hexadecimal digits, always — a rendering of fixed
    /// width cannot be confused with a truncated one.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:016x}", self.0)
    }
}

/// How a link pose put the artefact at its address.
///
/// **The trace records which of the two was done, and the removal reads it
/// there.** Without that, a removal facing a regular file cannot tell a copy it
/// posed from a document somebody wrote, and the only way left to decide would
/// be to recognise the shape of what is on disk — the cascade this product
/// removed.
///
/// **It is a decision handed in, never a silent fallback.** A pose that tried a
/// symbolic link and quietly copied when the machine refused would record
/// whichever branch ran, and the branch that never runs on the machines the
/// suite runs on would be code nobody measures. The caller — which knows
/// whether the machine grants the privilege — says which, and both are
/// exercised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Placement {
    /// A symbolic link at the address, designating the shared store entry.
    Link,
    /// A copy of the artefact's bytes at the address. The store entry stays,
    /// and stays counted: the reference count and the removal are the same
    /// either way.
    Copy,
}

impl Placement {
    /// The word a trace records.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Link => "link",
            Self::Copy => "copy",
        }
    }

    /// The placement `written` names, or nothing. A word outside the two is not
    /// guessed at: a removal that guessed would undo something other than what
    /// was posed.
    pub fn read(written: &str) -> Option<Self> {
        match written {
            "link" => Some(Self::Link),
            "copy" => Some(Self::Copy),
            _ => None,
        }
    }
}

impl fmt::Display for Placement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What the registry still records against a shared store entry, besides the
/// thing being removed.
///
/// **It is an answer the registry gives, never a count taken off the disk.**
/// Counting links found on disk would be a second description of the same fact,
/// and two descriptions drift: the day they do, either a store entry is taken
/// away while something still designates it, or it is kept forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Referents {
    /// Something else the registry records still designates the store entry.
    Remaining,
    /// Nothing else does. Undoing this one leaves the store entry with nobody.
    Last,
}

/// One change to make on a disk. **A value**: this crate decides, and somebody
/// else carries out.
///
/// Every variant carries its own **pre-condition**, and that is the substance
/// rather than a formality. "Put these bytes here" and "put these bytes here if
/// what is here is still what I posed" are different promises, and only the
/// second one can be made to a directory somebody else owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Write these bytes where there is **nothing**. If something is there, the
    /// step fails naming the address: the product does not write over what it
    /// has not observed and recorded.
    Create {
        /// The address.
        address: PathBuf,
        /// The bytes.
        contents: String,
    },
    /// Replace the document at this address, **conditioned on the bytes the
    /// capture read**. Any divergence is a failure naming the file, never an
    /// applied write: the host rewrites its own settings documents, and it is
    /// the only concurrent writer the product can neither exclude nor foresee.
    Write {
        /// The address.
        address: PathBuf,
        /// The bytes to leave there.
        contents: String,
        /// The bytes the capture read — what the write is conditioned on.
        expected: String,
    },
    /// Put these bytes in the **shared store**, once. Already there with these
    /// bytes, there is nothing to do — that is what lets many things share one
    /// materialisation. Already there with **other** bytes, the step fails
    /// naming the entry: one store entry standing for two different contents is
    /// the one state a shared store must never reach.
    Materialise {
        /// The store entry.
        address: PathBuf,
        /// The bytes.
        contents: String,
    },
    /// Make a symbolic link at this address, designating `to`. If something is
    /// already at the address, the step fails naming it.
    Link {
        /// The address.
        address: PathBuf,
        /// What it designates.
        to: PathBuf,
    },
    /// Take away the symbolic link at this address, **only if it still
    /// designates `to`**. Anything else there is left alone and the step fails
    /// naming it: the product takes back what it posed, and nothing else.
    Unlink {
        /// The address.
        address: PathBuf,
        /// What the trace says it designates.
        to: PathBuf,
    },
    /// Take away the file at this address, **only if it still carries the same
    /// bytes as the store entry it was copied from**. Anything else is left
    /// alone and the step fails naming it.
    ///
    /// The comparison is against the store entry and not against bytes written
    /// into the trace, so that a removal needs nothing but what was recorded —
    /// and so that the registry never holds a second copy of an artefact whose
    /// one materialisation is the whole point of the shared store.
    Discard {
        /// The address.
        address: PathBuf,
        /// The store entry the copy was made from.
        same_as: PathBuf,
    },
    /// Take the shared store entry away, **only if it still carries the bytes
    /// that were materialised there**. Already nothing there is success, not a
    /// failure: absence is what this step is for, and it is reached.
    ///
    /// **The condition is not tidiness inside the product's own store.** A pose
    /// by link makes the address a door into the store: what an owner writes at
    /// the address travels through the link and lands in the store entry itself.
    /// Taking it away unconditionally would destroy those bytes, silently, and
    /// report success — while the same removal posed by copy refuses, comparing
    /// what is at the address against the materialisation. The two placements
    /// answer the same gesture the same way.
    Remove {
        /// The store entry.
        address: PathBuf,
        /// The fingerprint of the bytes the pose materialised there.
        posed: Digest,
    },
    /// Give an address back the state a capture seized, whatever is there now.
    /// This is the one step a rollback is made of.
    Restore {
        /// The state to give back.
        seized: Seized,
    },
}

impl Effect {
    /// The address this step changes.
    ///
    /// It is what the transaction checks against the capture: a step touching
    /// an address the capture never named is a step whose rollback would give
    /// nothing back.
    pub fn address(&self) -> &Path {
        match self {
            Self::Create { address, .. }
            | Self::Write { address, .. }
            | Self::Materialise { address, .. }
            | Self::Link { address, .. }
            | Self::Unlink { address, .. }
            | Self::Discard { address, .. }
            | Self::Remove { address, .. } => address,
            Self::Restore { seized } => seized.address(),
        }
    }
}

/// What was at one address before anything was changed.
///
/// It carries the state **itself**, and not the fact that there was one. The
/// distinction is the whole of the requirement: a flag saying "this pose was
/// fresh" restores an absence and nothing else, so an update interrupted on an
/// entry already present gives back nothing at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seized {
    /// Nothing was there.
    Absent {
        /// The address.
        address: PathBuf,
    },
    /// A file was there, carrying these bytes.
    Document {
        /// The address.
        address: PathBuf,
        /// The bytes it carried, whole.
        contents: String,
    },
    /// A symbolic link was there, designating this.
    Link {
        /// The address.
        address: PathBuf,
        /// What it designated.
        to: PathBuf,
    },
}

impl Seized {
    /// The address this state was seized at.
    pub fn address(&self) -> &Path {
        match self {
            Self::Absent { address }
            | Self::Document { address, .. }
            | Self::Link { address, .. } => address,
        }
    }
}

/// The state a behaviour seized **before** it changed anything: every address
/// it was about to change, and what was at each.
///
/// The shared store is in here as an address like any other, and that is what
/// makes the rollback cover a store entry the transaction removed. A
/// compensation written per kind of operation never covered it — it knew how to
/// undo a write to a file at a path, and a store entry that had lost its last
/// referent was not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    seized: Vec<Seized>,
}

impl Captured {
    /// The capture of these states, in the order their addresses were about to
    /// be changed.
    pub fn of(seized: Vec<Seized>) -> Self {
        Self { seized }
    }

    /// The states, in that same order.
    pub fn seized(&self) -> &[Seized] {
        &self.seized
    }

    /// Whether this capture seized the state of `address`.
    pub fn holds(&self, address: &Path) -> bool {
        self.seized.iter().any(|held| held.address() == address)
    }
}

/// What giving a captured state back amounts to. A value, because this crate
/// writes nothing: the caller carries it out.
#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use = "these steps give back the state a capture seized; dropping them leaves the machine \
              half changed under a failure that says it was given back"]
pub struct Restoration {
    /// The steps, in the order they must be carried out.
    pub effects: Vec<Effect>,
}

/// Turns a capture into the steps that give it back.
///
/// **In the reverse order of the changes**, and that is not a detail: a pose
/// materialises a store entry and then links to it, so giving it back the other
/// way round would take the store entry away while the link still designated
/// it. There would be an instant — and, if the rollback then failed, a lasting
/// state — in which a link on the machine pointed at nothing.
fn give_back(captured: &Captured) -> Restoration {
    Restoration {
        effects: captured
            .seized()
            .iter()
            .rev()
            .map(|seized| Effect::Restore {
                seized: seized.clone(),
            })
            .collect(),
    }
}

/// Where a behaviour acts, and what the caller **read** there.
///
/// `observed` is `None` when nothing is at the address. The read happened
/// elsewhere: this crate is handed its result so that a pose can be computed
/// without a disk.
#[derive(Debug, Clone, Copy)]
pub struct Subject<'a> {
    /// The address the behaviour acts at, as its owner would recognise it.
    pub address: &'a Path,
    /// What was read there, or `None` when there was nothing to read.
    pub observed: Option<&'a str>,
}

/// What a pose is given: what the catalogue publishes, and what the product
/// decided about where it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fragment {
    /// An edit expressed in the structure of a named grammar.
    Grammar {
        /// The grammar the edit is written against.
        grammar: GrammarName,
        /// What to write.
        edit: Edit,
    },
    /// A whole artefact, materialised once in the shared store and designated
    /// from as many addresses as there are things asking for it.
    Artefact {
        /// The entry in the shared store. **The product decides it, not the
        /// catalogue**: it travels here as a value so that this crate stays
        /// able to compute a pose without knowing where anybody's home
        /// directory is.
        store: PathBuf,
        /// The bytes of the artefact.
        contents: String,
        /// Whether the address gets a link or a copy.
        placement: Placement,
    },
}

/// What the registry records so that a pose can be undone by **replaying** it,
/// never by recognising shapes on disk.
///
/// **Two of the three variants carry what undoes them; the third carries
/// nothing of the kind, and that is not an omission.** [`Trace::Grammar`] and
/// [`Trace::Link`] are each produced by a step that wrote something, so each
/// names its own opposite — an [`Inverse`] value, or the store entry and
/// fingerprint a removal is conditioned on. [`Trace::Witnessed`] is produced by
/// a step that wrote nothing at all: there is no opposite to compute, so there
/// is no field here to hold one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trace {
    /// An edit to be undone through a named grammar.
    Grammar {
        /// The grammar the pose was written through.
        grammar: GrammarName,
        /// What undoes it.
        inverse: Inverse,
    },
    /// A link out of the shared store, to be undone by taking the address back
    /// and — when nothing else designates it any more — the store entry with
    /// it.
    Link {
        /// The store entry the pose materialised.
        store: PathBuf,
        /// What the pose put at the address.
        placement: Placement,
        /// The fingerprint of the bytes materialised in the store entry.
        ///
        /// **It is here because the removal of the store entry is conditioned
        /// on it**, and a removal reads its conditions out of the trace and out
        /// of nothing else. Left to be looked up in the entry beside the trace,
        /// the condition would depend on a field whose meaning differs from one
        /// behaviour to the next; recomputed from what is on the disk, it would
        /// compare the store entry with itself and condition nothing at all.
        posed: Digest,
    },
    /// A presence this build only **observed** — nothing was written, so
    /// there is nothing recorded that could ever give it back.
    ///
    /// **It carries no inverse, and that is its entire meaning.** A value
    /// built along this path never wrote to a machine, so handing it an
    /// inverse to carry would assert a right over bytes the product never
    /// put there. The absence is not merely documented — it is checked: the
    /// variant carries no field at all, so no destructuring of it can
    /// produce one.
    ///
    /// ```compile_fail
    /// use rigger_plan::Trace;
    ///
    /// let trace = Trace::Witnessed;
    /// let Trace::Witnessed(inverse) = trace else {
    ///     unreachable!()
    /// };
    /// let _ = inverse;
    /// ```
    ///
    /// Its twin, which differs by the one gesture and compiles — without it
    /// the refusal above would be indistinguishable from a typo that just
    /// spelled the pattern wrong:
    ///
    /// ```
    /// use rigger_plan::Trace;
    ///
    /// let trace = Trace::Witnessed;
    /// let Trace::Witnessed = trace else {
    ///     unreachable!()
    /// };
    /// ```
    Witnessed,
}

impl Trace {
    /// The store entry this trace designates, when it designates one.
    ///
    /// It is what the registry counts referents by: a store entry is taken away
    /// at the last of them, and "the last" is a question about the registry.
    pub fn store(&self) -> Option<&Path> {
        match self {
            Self::Link { store, .. } => Some(store),
            Self::Grammar { .. } | Self::Witnessed => None,
        }
    }
}

/// The trace as the registry writes it: escaped fields, decided by the
/// behaviour that posed.
///
/// **The registry does not read them**, and that is deliberate. It holds the
/// behaviour as a *name*, unresolved, because the closed set may shrink between
/// two versions and an entry naming a behaviour this build no longer carries
/// has to stay a **readable** entry with an **unresolved** behaviour. Resolving
/// it while decoding would turn it into a corrupt line, reported unjudgeable
/// with the wrong reason, and the refusal that must name the behaviour, the
/// version that posed it and the file would never happen.
pub fn record(trace: &Trace) -> Result<Vec<String>, BehaviourError> {
    match trace {
        Trace::Link {
            store,
            placement,
            posed,
        } => {
            let spelled = store
                .to_str()
                .ok_or_else(|| BehaviourError::AddressNotSpellable {
                    behaviour: BehaviourName::Link,
                    address: store.clone(),
                })?;
            Ok(vec![
                spelled.to_string(),
                placement.as_str().to_string(),
                posed.to_string(),
            ])
        }
        Trace::Grammar { .. } => Err(BehaviourError::NotRecordable {
            behaviour: BehaviourName::Merge,
        }),
        // Nothing was written, so there is nothing to record that could give
        // it back — the empty list, and not a new field. The registry already
        // reads an absent trace as a legitimate empty one, so this needs no
        // format bump: the arity of a trace belongs to the behaviour that
        // posed, and zero is the arity this one has.
        Trace::Witnessed => Ok(Vec::new()),
    }
}

/// Reads a trace back out of what the registry recorded.
///
/// The behaviour is resolved **first**, by the caller, out of the name the
/// entry carries — that is where the closed set closes. What arrives here is a
/// member and its fields, and a field this build cannot read is a refusal that
/// says so, never a guess: a guessed trace undoes something other than what was
/// posed.
pub fn replay(name: BehaviourName, fields: &[String]) -> Result<Trace, BehaviourError> {
    match name {
        BehaviourName::Link => match fields {
            [store, placement, posed] => {
                let placement =
                    Placement::read(placement).ok_or_else(|| BehaviourError::TraceUnreadable {
                        behaviour: name,
                        reason: format!(
                            "`{placement}` is not a placement this build wrote — the two it writes \
                             are `link` and `copy`"
                        ),
                    })?;
                let posed = Digest::read(posed).ok_or_else(|| BehaviourError::TraceUnreadable {
                    behaviour: name,
                    reason: format!(
                        "`{posed}` is not a fingerprint this build wrote — sixteen lowercase \
                         hexadecimal digits are, and the removal of the store entry is conditioned \
                         on it"
                    ),
                })?;
                Ok(Trace::Link {
                    store: PathBuf::from(store),
                    placement,
                    posed,
                })
            }
            other => Err(BehaviourError::TraceUnreadable {
                behaviour: name,
                reason: format!(
                    "the trace carries {} fields, and a link trace is a store entry, a placement \
                     and the fingerprint of what was materialised",
                    other.len()
                ),
            }),
        },
        BehaviourName::Merge => Err(BehaviourError::NotRecordable {
            behaviour: BehaviourName::Merge,
        }),
        // A presence this build only observed records nothing, and reads back
        // as the shape that carries nothing.
        //
        // **The registry accepted writing this and could not read it back**,
        // which is the asymmetry this arm closes. `Entry::posted` admits the
        // pairing of a probe with a witnessed trace, and recording one writes
        // the empty list; without an arm here the same entry came back as
        // `NotBuilt`, indistinguishable from a behaviour this build does not
        // serve at all. The referent count reads that difference: a trace it
        // cannot read must keep counting, since somebody may still need what it
        // might designate, while a trace that designates nothing must not — and
        // it could not tell the two apart while this arm was missing.
        BehaviourName::Probe => match fields {
            [] => Ok(Trace::Witnessed),
            other => Err(BehaviourError::TraceUnreadable {
                behaviour: name,
                reason: format!(
                    "a presence this build only observed records nothing, and this line carries \
                     {} field(s)",
                    other.len()
                ),
            }),
        },
        other => Err(BehaviourError::NotBuilt { behaviour: other }),
    }
}

/// What a pose produces: the steps to carry out, the trace that undoes them,
/// and the fingerprint of what was posed.
///
/// All three come out of the **same** computation, and that is the point: a
/// trace derived afterwards from what is on disk would describe a document
/// nobody promised had stayed put.
#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use = "a computed pose is carried out by somebody else; dropping it poses nothing"]
pub struct Posed {
    /// The steps, in the order they must be carried out.
    pub effects: Vec<Effect>,
    /// What undoes this pose, in the form the registry records.
    pub trace: Trace,
    /// The fingerprint of the bytes that were posed.
    pub fingerprint: Digest,
}

/// What replaying a trace backwards produces.
#[derive(Debug, Clone, PartialEq, Eq)]
#[must_use = "these are the steps that take the thing back off; dropping them removes nothing"]
pub struct Undone {
    /// The steps, in the order they must be carried out.
    pub effects: Vec<Effect>,
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
    /// The fragment, or the trace, is not of the shape this member serves. It
    /// is refused rather than interpreted: reading a link trace as a merge one
    /// is the recognition cascade wearing another name.
    WrongShape {
        /// The member.
        behaviour: BehaviourName,
        /// What it serves.
        serves: &'static str,
    },
    /// This version of the product records no registry trace for this member,
    /// so it does not pose through it either.
    ///
    /// **Nothing is ever put on a machine whose trace the registry could not
    /// hold**: the transaction asks for the record before it changes anything.
    /// A pose recorded by nothing is a thing permanently unremovable, which is
    /// the one damage this crate is shaped against — and it is worse than a
    /// refusal, because nobody sees it.
    NotRecordable {
        /// The member.
        behaviour: BehaviourName,
    },
    /// What the registry recorded does not read back as a trace of this member.
    TraceUnreadable {
        /// The member.
        behaviour: BehaviourName,
        /// What could not be read.
        reason: String,
    },
    /// A path the registry cannot spell — it is a UTF-8 document, and a path is
    /// an arbitrary byte string. Recording it under another spelling would name
    /// an address that does not exist, and what was posed could never be found
    /// again.
    AddressNotSpellable {
        /// The member.
        behaviour: BehaviourName,
        /// The path that was offered.
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
            Self::WrongShape { behaviour, serves } => write!(
                f,
                "behaviour `{behaviour}` serves {serves}, and it was handed something else — it \
                 refuses rather than interpret, because reading one shape as another is how a \
                 removal comes to undo what it never posed"
            ),
            Self::NotRecordable { behaviour } => write!(
                f,
                "behaviour `{behaviour}`: this version of the product records no registry trace \
                 for it, so it does not pose through it — a pose the registry cannot describe is a \
                 thing nothing can ever remove"
            ),
            Self::TraceUnreadable { behaviour, reason } => write!(
                f,
                "behaviour `{behaviour}`: the recorded trace does not read back — {reason}"
            ),
            Self::AddressNotSpellable { behaviour, address } => write!(
                f,
                "behaviour `{behaviour}`: {} is not UTF-8, and the registry is a UTF-8 document — \
                 it is not recorded under another spelling, because a record naming an address \
                 that does not exist can never be undone",
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
/// use std::path::{Path, PathBuf};
///
/// use rigger_plan::{
///     Behaviour, BehaviourError, BehaviourName, Captured, Effect, Fragment, Posed, Referents,
///     Restoration, Subject, Trace, Undone,
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
///     fn undo(&self, _: Subject<'_>, _: &Trace, _: Referents) -> Result<Undone, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn capture(&self, effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError> {
///         Ok(effects.iter().map(|effect| effect.address().to_path_buf()).collect())
///     }
///     fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError> {
///         Ok(Restoration { effects: Vec::new() })
///     }
/// }
///
/// let effects = vec![Effect::Create {
///     address: PathBuf::from("settings.json"),
///     contents: "{}\n".to_string(),
/// }];
/// assert_eq!(
///     Outsider.capture(&effects).unwrap(),
///     vec![PathBuf::from("settings.json")]
/// );
/// ```
///
/// The same behaviour with `capture` left out. It does not compile, and that is
/// the requirement:
///
/// ```compile_fail
/// use std::path::{Path, PathBuf};
///
/// use rigger_plan::{
///     Behaviour, BehaviourError, BehaviourName, Captured, Effect, Fragment, Posed, Referents,
///     Restoration, Subject, Trace, Undone,
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
///     fn undo(&self, _: Subject<'_>, _: &Trace, _: Referents) -> Result<Undone, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError> {
///         Ok(Restoration { effects: Vec::new() })
///     }
/// }
///
/// let effects = vec![Effect::Create {
///     address: PathBuf::from("settings.json"),
///     contents: "{}\n".to_string(),
/// }];
/// assert_eq!(
///     Outsider.capture(&effects).unwrap(),
///     vec![PathBuf::from("settings.json")]
/// );
/// ```
///
/// The same behaviour with `restore` left out. It does not compile either — a
/// capture nothing gives back does not make a rollback:
///
/// ```compile_fail
/// use std::path::{Path, PathBuf};
///
/// use rigger_plan::{
///     Behaviour, BehaviourError, BehaviourName, Captured, Effect, Fragment, Posed, Referents,
///     Restoration, Subject, Trace, Undone,
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
///     fn undo(&self, _: Subject<'_>, _: &Trace, _: Referents) -> Result<Undone, BehaviourError> {
///         Err(BehaviourError::NotBuilt { behaviour: self.name() })
///     }
///     fn capture(&self, effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError> {
///         Ok(effects.iter().map(|effect| effect.address().to_path_buf()).collect())
///     }
/// }
///
/// let effects = vec![Effect::Create {
///     address: PathBuf::from("settings.json"),
///     contents: "{}\n".to_string(),
/// }];
/// assert_eq!(
///     Outsider.capture(&effects).unwrap(),
///     vec![PathBuf::from("settings.json")]
/// );
/// ```
pub trait Behaviour {
    /// The member of the closed set this implementation serves.
    fn name(&self) -> BehaviourName;

    /// **The grammar.** Computes the steps to carry out and the trace that
    /// undoes them, out of one and the same reading of the subject.
    ///
    /// **Nothing has been written when this returns** — this crate writes
    /// nothing at all — so dropping what comes back is not a half-finished
    /// state, it is a pose that was computed and never carried:
    ///
    /// ```compile_fail
    /// #![deny(unused_must_use)]
    /// use std::path::{Path, PathBuf};
    /// use rigger_plan::{behaviour, Behaviour, BehaviourName, Fragment, Placement, Subject};
    ///
    /// let served = behaviour(BehaviourName::Link);
    /// let fragment = Fragment::Artefact {
    ///     store: PathBuf::from("/store/acme-review-1.0"),
    ///     contents: "# Review\n".to_string(),
    ///     placement: Placement::Link,
    /// };
    /// let subject = Subject { address: Path::new("review.md"), observed: None };
    /// served.pose(subject, &fragment).unwrap();
    /// ```
    ///
    /// Its twin, which differs by the one gesture and compiles — without it the
    /// refusal above would be indistinguishable from a typo:
    ///
    /// ```no_run
    /// use std::path::{Path, PathBuf};
    /// use rigger_plan::{behaviour, Behaviour, BehaviourName, Fragment, Placement, Subject};
    ///
    /// let served = behaviour(BehaviourName::Link);
    /// let fragment = Fragment::Artefact {
    ///     store: PathBuf::from("/store/acme-review-1.0"),
    ///     contents: "# Review\n".to_string(),
    ///     placement: Placement::Link,
    /// };
    /// let subject = Subject { address: Path::new("review.md"), observed: None };
    /// let posed = served.pose(subject, &fragment).unwrap();
    /// carry_out(&posed.effects);
    /// # fn carry_out(_: &[rigger_plan::Effect]) {}
    /// ```
    fn pose(&self, subject: Subject<'_>, fragment: &Fragment) -> Result<Posed, BehaviourError>;

    /// **The inverse.** Replays a recorded trace backwards, and returns the
    /// steps that take the pose back off. Never a recognition of shapes: the
    /// trace is the only link between a pose and its undoing, which is why
    /// `referents` — the one thing the trace cannot know, because it is a
    /// question about the registry as it stands **now** — is handed in rather
    /// than counted off the disk.
    ///
    /// **Dropping what comes back removes nothing**, and leaves the thing posed
    /// with its trace still recorded — a removal that was computed and never
    /// carried:
    ///
    /// ```compile_fail
    /// #![deny(unused_must_use)]
    /// use std::path::{Path, PathBuf};
    /// use rigger_plan::{
    ///     behaviour, Behaviour, BehaviourName, Digest, Placement, Referents, Subject, Trace,
    /// };
    ///
    /// let served = behaviour(BehaviourName::Link);
    /// let trace = Trace::Link {
    ///     store: PathBuf::from("/store/acme-review-1.0"),
    ///     placement: Placement::Link,
    ///     posed: Digest::of(b"# Review\n"),
    /// };
    /// let subject = Subject { address: Path::new("review.md"), observed: None };
    /// served.undo(subject, &trace, Referents::Last).unwrap();
    /// ```
    ///
    /// Its twin, which differs by the one gesture and compiles — without it the
    /// refusal above would be indistinguishable from a typo:
    ///
    /// ```no_run
    /// use std::path::{Path, PathBuf};
    /// use rigger_plan::{
    ///     behaviour, Behaviour, BehaviourName, Digest, Placement, Referents, Subject, Trace,
    /// };
    ///
    /// let served = behaviour(BehaviourName::Link);
    /// let trace = Trace::Link {
    ///     store: PathBuf::from("/store/acme-review-1.0"),
    ///     placement: Placement::Link,
    ///     posed: Digest::of(b"# Review\n"),
    /// };
    /// let subject = Subject { address: Path::new("review.md"), observed: None };
    /// let undone = served.undo(subject, &trace, Referents::Last).unwrap();
    /// carry_out(&undone.effects);
    /// # fn carry_out(_: &[rigger_plan::Effect]) {}
    /// ```
    fn undo(
        &self,
        subject: Subject<'_>,
        trace: &Trace,
        referents: Referents,
    ) -> Result<Undone, BehaviourError>;

    /// **The capture.** Names every address these steps are about to change, so
    /// that what is there can be seized whole before anything is written.
    ///
    /// It names addresses and does not read them, because this crate reads
    /// nothing. The transaction that carries the steps out **refuses any step
    /// touching an address this did not name**: a behaviour that under-declares
    /// what it changes would leave a rollback with nothing to give back, and no
    /// test written after the fact recovers that.
    ///
    /// It has no default body, and that is the requirement rather than a style:
    /// a behaviour that cannot say what it changes cannot give it back, so it
    /// cannot enter a transaction whose rollback is promised. See the examples
    /// on this trait — the second of them is this sentence, checked by the
    /// compiler.
    fn capture(&self, effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError>;

    /// **The restoration.** Says what giving a captured state back amounts to.
    ///
    /// It is separate from [`Behaviour::undo`], and the two are not
    /// interchangeable. Undoing replays the trace of a **completed** pose;
    /// restoring gives back a state seized before a pose that did not complete.
    /// A transaction interrupted between the two has no trace to replay, and it
    /// is precisely then that the capture is all there is.
    ///
    /// **This one is the exception among the three, and the difference is worth
    /// naming.** Dropping a computed pose or a computed removal is an omission:
    /// the work is not carried, and nothing claims it was. Dropping *this* is a
    /// lie. It is asked for on the failure path, after a step has already
    /// changed the machine, and the caller answers that path with a failure
    /// whose whole meaning is that the machine was put back. Let these steps go
    /// and the machine stays half changed underneath an error that says it is
    /// not — the one state the transaction exists to make impossible.
    ///
    /// ```compile_fail
    /// #![deny(unused_must_use)]
    /// use rigger_plan::{behaviour, Behaviour, BehaviourName, Captured};
    ///
    /// let served = behaviour(BehaviourName::Link);
    /// let captured = Captured::of(Vec::new());
    /// served.restore(&captured).unwrap();
    /// ```
    ///
    /// Its twin, which differs by the one gesture and compiles — without it the
    /// refusal above would be indistinguishable from a typo:
    ///
    /// ```no_run
    /// use rigger_plan::{behaviour, Behaviour, BehaviourName, Captured};
    ///
    /// let served = behaviour(BehaviourName::Link);
    /// let captured = Captured::of(Vec::new());
    /// let giving_back = served.restore(&captured).unwrap();
    /// carry_out(&giving_back.effects);
    /// # fn carry_out(_: &[rigger_plan::Effect]) {}
    /// ```
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

/// Every address a list of steps changes, each named once, in the order they
/// are first touched.
///
/// The order is the one the restoration reverses, so it is part of the promise
/// rather than an artefact of how the list was built.
fn addresses(effects: &[Effect]) -> Vec<PathBuf> {
    let mut named: Vec<PathBuf> = Vec::new();
    for effect in effects {
        let address = effect.address().to_path_buf();
        if !named.contains(&address) {
            named.push(address);
        }
    }
    named
}

/// Pose a file by link, out of a shared store.
///
/// **The simplest member of the set, and the one the tracer bullet goes
/// through.** It materialises the artefact **once** in a shared store, and
/// designates it from as many addresses as ask for it. It writes into no
/// document anybody owns, it parses nothing, it leaves no marker: there is
/// nothing here that can destroy what a user wrote.
///
/// **Its removal of a store entry that has lost its last referent goes through
/// the transaction's capture, and never through a direct path that deletes as
/// soon as a count reaches zero.** With that second path a rollback has nothing
/// to give back, and no amount of test added later recovers it — which is why
/// the removal of the store entry is a step of the same list as the rest,
/// seized like the rest.
pub struct Link;

impl Behaviour for Link {
    fn name(&self) -> BehaviourName {
        BehaviourName::Link
    }

    /// Materialise once, then designate.
    ///
    /// The store entry comes **first** in the list, and the address second.
    /// That order is what lets the rollback reverse it and never leave a link
    /// designating something already taken away.
    fn pose(&self, subject: Subject<'_>, fragment: &Fragment) -> Result<Posed, BehaviourError> {
        let Fragment::Artefact {
            store,
            contents,
            placement,
        } = fragment
        else {
            return Err(BehaviourError::WrongShape {
                behaviour: BehaviourName::Link,
                serves: "an artefact materialised in the shared store",
            });
        };
        let at_the_address = match placement {
            Placement::Link => Effect::Link {
                address: subject.address.to_path_buf(),
                to: store.clone(),
            },
            Placement::Copy => Effect::Create {
                address: subject.address.to_path_buf(),
                contents: contents.clone(),
            },
        };
        let fingerprint = Digest::of(contents.as_bytes());
        Ok(Posed {
            effects: vec![
                Effect::Materialise {
                    address: store.clone(),
                    contents: contents.clone(),
                },
                at_the_address,
            ],
            trace: Trace::Link {
                store: store.clone(),
                placement: *placement,
                posed: fingerprint,
            },
            fingerprint,
        })
    }

    /// Take the address back, and the store entry with it at the last referent.
    ///
    /// **Nothing here reads the disk, and nothing here recognises a shape on
    /// it.** What the address carries is read out of the trace — that is what
    /// `placement` is recorded for — and the step that takes it away carries
    /// the condition that it still be that: a link still designating the store
    /// entry, or a file still carrying the bytes. Anything else is left alone
    /// and named, because the product takes back what it posed and nothing
    /// else.
    fn undo(
        &self,
        subject: Subject<'_>,
        trace: &Trace,
        referents: Referents,
    ) -> Result<Undone, BehaviourError> {
        let Trace::Link {
            store,
            placement,
            posed,
        } = trace
        else {
            return Err(BehaviourError::WrongShape {
                behaviour: BehaviourName::Link,
                serves: "an artefact materialised in the shared store",
            });
        };
        let mut effects = vec![match placement {
            Placement::Link => Effect::Unlink {
                address: subject.address.to_path_buf(),
                to: store.clone(),
            },
            Placement::Copy => Effect::Discard {
                address: subject.address.to_path_buf(),
                same_as: store.clone(),
            },
        }];
        if referents == Referents::Last {
            effects.push(Effect::Remove {
                address: store.clone(),
                posed: *posed,
            });
        }
        Ok(Undone { effects })
    }

    fn capture(&self, effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError> {
        Ok(addresses(effects))
    }

    fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError> {
        Ok(give_back(captured))
    }
}

/// Merge a fragment into a document owned by the user.
///
/// The pose delegates to the merge of the grammar crate, which carries the
/// admission gate, the edit and the post-condition — including the half of it
/// that runs the computed trace backwards and demands the bytes from before.
/// Nothing of that is re-decided here: this member's own substance is the
/// quadruplet.
pub struct Merge;

impl Behaviour for Merge {
    fn name(&self) -> BehaviourName {
        BehaviourName::Merge
    }

    fn pose(&self, subject: Subject<'_>, fragment: &Fragment) -> Result<Posed, BehaviourError> {
        let Fragment::Grammar { grammar, edit } = fragment else {
            return Err(BehaviourError::WrongShape {
                behaviour: BehaviourName::Merge,
                serves: "an edit written against a named grammar",
            });
        };
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
            fingerprint: Digest::of(merged.rendered.as_bytes()),
            effects: vec![Effect::Write {
                address: subject.address.to_path_buf(),
                contents: merged.rendered,
                // What the capture read, and never a second reading: a second
                // one would reopen the window the conditional write closes.
                expected: source.to_string(),
            }],
            trace: Trace::Grammar {
                grammar: *grammar,
                inverse: merged.inverse,
            },
        })
    }

    /// **The inverse, under the post-condition of the removal.**
    ///
    /// It goes through [`unmerge`] and never through the bare inverse of the
    /// grammar, and the difference is a document its owner keeps. The pose
    /// proves itself reversible against the document it read, at the moment it
    /// read it; the owner writes afterwards, and the host that is served
    /// rewrites these documents routinely. So the passage a trace excises at
    /// removal time is one nobody has proved anything about, and a bare inverse
    /// takes whatever has since moved into it — measured: a key posed here, an
    /// end-of-line comment its owner added to that key, and a removal that
    /// returned the byte count from before while the comment was gone.
    fn undo(
        &self,
        subject: Subject<'_>,
        trace: &Trace,
        _referents: Referents,
    ) -> Result<Undone, BehaviourError> {
        let Trace::Grammar { grammar, inverse } = trace else {
            return Err(BehaviourError::WrongShape {
                behaviour: BehaviourName::Merge,
                serves: "an edit written against a named grammar",
            });
        };
        let source = self.document(subject)?;
        let contents = match grammar {
            GrammarName::Jsonc => unmerge::<Jsonc>(source, inverse),
            GrammarName::Toml => unmerge::<Toml>(source, inverse),
        }?;
        Ok(Undone {
            effects: vec![Effect::Write {
                address: subject.address.to_path_buf(),
                contents,
                expected: source.to_string(),
            }],
        })
    }

    /// The one address it changes — the document.
    ///
    /// What the transaction then seizes there is the **whole** document, and
    /// not the fact that there was one. A capture that recorded presence only
    /// would restore an absence, so an update interrupted on an entry already
    /// present would give back nothing, leaving the disk on the new version and
    /// the registry on the old one.
    fn capture(&self, effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError> {
        Ok(addresses(effects))
    }

    fn restore(&self, captured: &Captured) -> Result<Restoration, BehaviourError> {
        Ok(give_back(captured))
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

    fn undo(
        &self,
        _subject: Subject<'_>,
        _trace: &Trace,
        _referents: Referents,
    ) -> Result<Undone, BehaviourError> {
        not_built(BehaviourName::Delegate)
    }

    fn capture(&self, _effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError> {
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

    fn undo(
        &self,
        _subject: Subject<'_>,
        _trace: &Trace,
        _referents: Referents,
    ) -> Result<Undone, BehaviourError> {
        not_built(BehaviourName::Probe)
    }

    fn capture(&self, _effects: &[Effect]) -> Result<Vec<PathBuf>, BehaviourError> {
        not_built(BehaviourName::Probe)
    }

    fn restore(&self, _captured: &Captured) -> Result<Restoration, BehaviourError> {
        not_built(BehaviourName::Probe)
    }
}
