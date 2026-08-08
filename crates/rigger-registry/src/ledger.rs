//! What the registry holds, and how it is read back.
//!
//! # The envelope fails closed, and the entries do not
//!
//! Two levels, two policies, and confusing them costs in opposite directions.
//!
//! **The envelope is refused whole.** A registry whose top-level envelope is not
//! the one this build expects is refused by naming what was found and what was
//! expected, before anything is written, and it is **never** coerced into an
//! empty registry. A registry coerced empty and then rewritten destroys the only
//! description of what was posed on the machine: everything the product had put
//! there becomes unremovable in the same gesture, and the machine believes
//! itself clean.
//!
//! **An entry is tolerated alone.** One unreadable entry out of twelve is
//! reported unjudgeable **with its reason**, the eleven others are returned, and
//! the command does not fail. Applying the envelope's policy here would lose
//! eleven valid traces for one corrupt entry; applying this one to the envelope
//! would accept a registry nothing is known about.
//!
//! **An unreadable entry is also written back, byte for byte.** It is not
//! dropped on the next write. Dropping it would be the envelope's damage at the
//! granularity of an entry — the description of something posed, gone, and what
//! it describes unremovable.
//!
//! **A line repeating an [`Identity`] already read is unjudgeable too**, and for
//! that same reason rather than out of strictness. Two records under one
//! identity are not a state this build writes, so nothing here knows which of
//! them describes what was posed; folding them together at the read would drop
//! one, and the next write would take its line out of the file. A perfectly
//! readable line would then be treated worse than an illegible one — the
//! description of something posed gone, and what it describes unremovable, with
//! no error and nothing counted.
//!
//! **The identity, and never the name alone.** Two catalogues may legitimately
//! carry an entry of the same name, and everything here that looks a record up
//! — the read, the upsert, the removal, the count of referents — is keyed on the
//! pair. Keyed on the name, recording one catalogue's entry takes the other's
//! line out of the file and leaves its files on the machine with nothing able to
//! reach them: the loss this crate exists against, produced by the write path
//! itself.
//!
//! **And no address is recorded in a spelling other than its own.** The
//! registry is a UTF-8 document; a path is not. [`Address`] is where the two
//! meet, and it refuses rather than converts — see its own account of why.
//!
//! # An absent registry is empty; a malformed one is not
//!
//! Nothing has been posed on a machine where the file does not exist, and
//! reading it as empty describes that machine correctly. A file that is there
//! and does not read is a machine we know nothing about, and the two are not the
//! same observation. Every refusal below exists to keep them apart.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use rigger_apply::LockError;
use rigger_plan::{replay, BehaviourName, Referents};

use crate::backup::Backup;

/// The marker every registry document opens with.
pub(crate) const MARKER: &str = "rigger-registry";

/// The envelope version this build writes and reads.
///
/// **Version `2` is where an entry stopped being positional.** In version `1` a
/// line was seven fixed fields and then a tail of trace fields, so every field
/// ever added would have had to go in before that tail — reinterpreting the
/// first trace field of every line already written. That is not "this field
/// costs a format bump"; it is *any* field, for ever. A named field is added by
/// writing it, and a build that does not know it reads the entry all the same.
///
/// Version `1` is **refused and not migrated**. No registry in that format
/// exists outside the working directories of this suite: the product has no
/// command surface, no binary and no release, so a migration would be written
/// for a document that does not exist.
pub(crate) const FORMAT_VERSION: u32 = 2;

/// The word that opens an entry's line.
const ENTRY: &str = "entry";

/// The names of the fields this build writes and reads.
///
/// They are declared once and used by both the rendering and the reading: a name
/// written on one side and matched on the other, as two literals, is how a field
/// comes to be written under a name nothing reads back.
mod field {
    /// What the catalogue called the thing.
    pub(super) const ID: &str = "id";
    /// Which catalogue it came from.
    pub(super) const PROVENANCE: &str = "provenance";
    /// The name of the behaviour that posed it.
    pub(super) const BEHAVIOUR: &str = "behaviour";
    /// The version of the product that posed it.
    pub(super) const POSED_BY: &str = "posed_by";
    /// The effective root at the moment of the pose.
    pub(super) const ROOT: &str = "root";
    /// The address, under that root.
    pub(super) const ADDRESS: &str = "address";
    /// The fingerprint of the bytes that were posed.
    pub(super) const FINGERPRINT: &str = "fingerprint";
    /// The inverse, in the fields the behaviour that posed it wrote.
    pub(super) const TRACE: &str = "trace";

    /// Every name above, for telling a field this build knows from one it does
    /// not.
    pub(super) const KNOWN: [&str; 8] = [
        ID,
        PROVENANCE,
        BEHAVIOUR,
        POSED_BY,
        ROOT,
        ADDRESS,
        FINGERPRINT,
        TRACE,
    ];
}

/// What marks a field name as **deciding how the entry is written**, as opposed
/// to merely annotating it.
///
/// # Why the format needs two regimes and not one
///
/// A name this build does not know comes in two kinds, and treating them alike
/// is destructive in one direction.
///
/// An **annotation** — a label, a note, a piece of provenance — decides no
/// write. Ignoring it and carrying it through untouched is the founding rule of
/// this crate applied to its own format: an older build reading a registry
/// written by a newer one destroys nothing it does not understand.
///
/// A field that **decides a write** is the opposite. Ignoring one is writing
/// something other than what the record declares while believing the
/// declaration is being honoured. The concrete shape of that is not
/// hypothetical: a later version of this format will distinguish a thing the
/// product *posed* from a thing it merely *observed*, and a build that ignored
/// that distinction would take away bytes their owner wrote and the product
/// never put there. So a marked name this build does not carry makes the entry
/// unjudgeable, naming the field.
///
/// # Why the mark is a prefix, and this character
///
/// **A prefix makes the classification total.** The first character of a name
/// decides, always: no annotation can pass for a decision, and no decision for
/// an annotation, which is the one confusion that would make either regime
/// worthless.
///
/// `!` is not one of the four characters the escaping of a value produces or
/// consumes, so a name carrying it survives being written and read back
/// unchanged — and field names are not escaped at all, because a name is
/// already constrained: never empty, never carrying `=`, and unable to carry a
/// tabulation or a line break, since the document is split on those before a
/// name is ever looked at.
///
/// **No name this build knows is marked today**, and that is not an oversight:
/// nothing in this version decides a write from the registry. The day one does,
/// it is added to the names above and stops falling here — and a build released
/// before that day refuses the entry by itself, which is the behaviour wanted,
/// with no format bump to arrange it.
const DECIDES: char = '!';

/// The version of the product, as this build was compiled.
///
/// **From the build and never from a string written out by hand.** What it is
/// for is the day the closed set of behaviours *shrinks*: an entry naming a
/// behaviour this build no longer carries is refused by naming the behaviour,
/// the version that posed it, the file and what to undo by hand — and a version
/// copied by hand goes stale without anything going red, at which point the
/// refusal sends its reader to a build that never posed anything.
pub const POSED_BY: &str = env!("CARGO_PKG_VERSION");

/// Where a thing was posed, in the one spelling the registry is able to hold.
///
/// **A path is an arbitrary byte string, and the registry is a UTF-8 document.**
/// On the systems this product is released for, a file name may hold bytes no
/// UTF-8 decoder accepts, and people's home directories do. Rendering such a
/// path into the registry through a lossy conversion writes replacement bytes
/// where the original ones were: the registry then describes an address that
/// does not exist, a later removal replays the trace against that address and
/// finds nothing, and what was actually posed can never be found again. That is
/// the one damage this crate exists against, and it would be manufactured by
/// the product's own write path — silently, with nothing reported unjudgeable.
///
/// [`RegistryError::NotUtf8`] already refuses a whole registry rather than read
/// it "with replacement bytes that would destroy what they replace". This is
/// the same refusal on the way in, and it happens **at construction**, while
/// the caller still holds the real path and can say what it wanted — rather
/// than after a document has been rewritten around a spelling that names
/// nowhere.
///
/// [`Posting`] holds these and nothing else. Recording a path the registry
/// cannot spell is therefore not something anybody can write down; the check is
/// not one a caller is trusted to remember, because a caller who forgets it
/// compiles exactly as well as one who does not.
///
/// A path the registry can spell goes in:
///
/// ```
/// use std::path::Path;
/// use rigger_registry::Address;
/// let address = Address::new(Path::new("/home/someone/settings.json")).expect("a UTF-8 path");
/// assert_eq!(address.as_str(), "/home/someone/settings.json");
/// ```
///
/// And there is no second door for one it cannot. **The way in takes a path and
/// nothing else**, which is what makes this refusal a type rather than a rule
/// somebody remembers: the lossy conversion answers a `String`, so a constructor
/// that took one — directly, or through anything a `String` satisfies — would be
/// the door the loss walks through, and it would compile in two short words:
///
/// ```compile_fail
/// use rigger_registry::Address;
/// let spelled: String = std::path::Path::new("/home/someone")
///     .to_string_lossy()
///     .into_owned();
/// let _ = Address::new(spelled);
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address(String);

impl Address {
    /// The address of `path`, or a refusal naming the path that was offered.
    ///
    /// **It takes a `&Path` and not something a `String` also satisfies.** A
    /// caller holding a path that does not spell has `to_string_lossy` right
    /// there, and the result of it would have gone through a laxer signature
    /// carrying the replacement bytes this type exists to refuse — with the
    /// refusal below never reached, because by then there is nothing left to
    /// refuse.
    ///
    /// **What that leaves open, said rather than implied.** A caller can still
    /// wrap a lossy spelling back into a path and hand that in. Nothing can stop
    /// it, here or anywhere: at that point the bytes are already gone and no
    /// signature can tell such a path from one somebody typed. What this
    /// signature does close is the *short* way — the one a caller reaches for
    /// without deciding anything, and the one that used to compile.
    pub fn new(path: &Path) -> Result<Self, AddressNotUtf8> {
        match path.to_str() {
            Some(spelled) => Ok(Self(spelled.to_string())),
            None => Err(AddressNotUtf8 {
                path: path.to_path_buf(),
            }),
        }
    }

    /// The address as the registry writes it. Infallible, which is the whole
    /// point of the type: there is no place left where a conversion could go
    /// lossy.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The address as a path.
    pub fn as_path(&self) -> &Path {
        Path::new(&self.0)
    }

    /// The address of a line already read out of a registry.
    ///
    /// **Private on purpose, and [`Address::new`] is the only door from
    /// outside.** A public `From<String>` would be a second door, and it is the
    /// one a caller holding a path would reach for — `to_string_lossy` gives a
    /// `String`, so the conversion this type exists to refuse would be spelled
    /// in two short words and compile. What comes through here has already been
    /// read out of a UTF-8 document, so there is nothing left to check and
    /// nothing left to lose.
    fn from_document(spelled: String) -> Self {
        Self(spelled)
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The path offered as an address is not UTF-8, so the registry cannot record
/// it. Nothing was written.
///
/// Like every refusal here it advises no remedy, and it names the path as the
/// system spells it — lossily, because a message is read by a person and a
/// record is replayed by a machine. Which of the two may lose a byte is the
/// whole distinction this type exists to keep.
#[derive(Debug)]
pub struct AddressNotUtf8 {
    path: PathBuf,
}

impl AddressNotUtf8 {
    /// The path that was offered.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Display for AddressNotUtf8 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: this path is not UTF-8, and the registry is a UTF-8 document — it is not recorded \
             under another spelling, because a record naming an address that does not exist can \
             never be undone",
            self.path.display()
        )
    }
}

impl std::error::Error for AddressNotUtf8 {}

/// What names one record: the catalogue a thing came from, and what that
/// catalogue called it.
///
/// **Two fields and not one, everywhere the registry looks a record up.** Two
/// catalogues may legitimately carry an entry of the same name — `context/agents`
/// is a name two independent authors will both choose. Keyed on the name alone,
/// the registry holds one record for the two: recording the second replaces the
/// first, whose line then leaves the file at the next write, whose files stay on
/// the machine, and which nothing can ever reach again — with no error and
/// nothing counted. Taking one out has the same defect the other way round.
///
/// It is a type rather than two string parameters for the reason [`Posting`] is
/// a struct: two neighbouring strings can be handed over the wrong way round and
/// nothing goes red.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// Which catalogue it came from.
    pub provenance: String,
    /// What that catalogue called it.
    pub id: String,
}

impl fmt::Display for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "`{}` from `{}`", self.id, self.provenance)
    }
}

/// One thing the product posed.
///
/// **The behaviour is a name and not a resolved member of the closed set**, and
/// that is a decision rather than laziness. The set of behaviours may shrink
/// between two versions of the product, so a trace can name one this build no
/// longer carries. Resolving the name while decoding would turn such an entry
/// into a corrupt one — reported unjudgeable at the read, with the wrong reason
/// — and the refusal that has to name the behaviour, the version that posed it
/// and the file would never happen. An entry naming a behaviour this build does
/// not know is a **readable** entry whose behaviour is **unresolved**, and the
/// resolution belongs where the removal is decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    identity: Identity,
    behaviour: String,
    posed_by: String,
    root: Address,
    address: Address,
    fingerprint: String,
    trace: Vec<String>,
    unknown: Vec<UnknownField>,
}

/// A field of an entry this build does not know, kept as it was read.
///
/// **It is carried rather than dropped**, and that is the founding rule of this
/// crate turned on its own format: a registry written by a newer build is read
/// by an older one without the older one destroying what it cannot read.
///
/// **On both paths, and the second is the ordinary one.** Dropped at the read,
/// the field would disappear from the file at the next write. Dropped when a
/// record is written again over the same identity, it disappears just as
/// completely — and every re-pose goes that way, so that path is the one a
/// machine actually travels. Both are closed: the reading keeps it, and
/// [`Ledger::upsert`] carries it onto the record replacing the one that held it,
/// where what that costs and what it buys are written out.
///
/// **It is also handed to the caller**, and not only carried through, so that a
/// later reader can name what it found rather than discover it by diffing files.
///
/// **What that does not do, said plainly rather than dressed up.** Nothing tells
/// the person running the command that a field was ignored. The compatibility
/// contract this format serves asks for an ignored unknown key to be **named in
/// a warning**, and this crate has no channel to say anything at all — no
/// diagnostic, no report, no stream it writes to. That is a residual, not a
/// property: it is not "the shape a warning takes here". Where the channel
/// should live is an open question, and this type does not close it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownField {
    name: String,
    value: String,
}

impl UnknownField {
    /// The name, as the record spells it.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The value, read back out of the document.
    pub fn value(&self) -> &str {
        &self.value
    }
}

/// Everything one pose has to record, named field by field.
///
/// **It is a struct and not a row of positional arguments**, and that is not
/// presentation. Eight values, six of which are strings, is a signature in
/// which two neighbours can be swapped and nothing goes red — and the pair that
/// would be swapped is the effective root and the address, which is exactly the
/// pair that decides where a removal looks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posting {
    /// What the catalogue called this thing.
    pub id: String,
    /// Which catalogue it came from. Two catalogues may legitimately carry an
    /// entry of the same name, and without this the two records are one.
    pub provenance: String,
    /// The **name** of the behaviour that posed it.
    pub behaviour: String,
    /// The version of the product that posed it — see [`POSED_BY`].
    pub posed_by: String,
    /// The effective root **at the moment of the pose**.
    pub root: Address,
    /// The address, under that root.
    pub address: Address,
    /// The fingerprint of the bytes that were posed.
    pub fingerprint: String,
    /// The inverse, in the fields the behaviour that posed it writes.
    pub trace: Vec<String>,
}

impl Entry {
    /// Records one pose.
    ///
    /// The root and the address are [`Address`]es and not paths, so a path the
    /// registry cannot spell is refused where it is offered rather than
    /// recorded as a different one:
    ///
    /// ```
    /// use std::path::Path;
    /// use rigger_registry::{Address, Entry, Posting};
    /// let entry = Entry::posted(Posting {
    ///     id: "acme/skill".to_string(),
    ///     provenance: "acme".to_string(),
    ///     behaviour: "link".to_string(),
    ///     posed_by: "1.5".to_string(),
    ///     root: Address::new(Path::new("/home/someone/.claude")).expect("a UTF-8 path"),
    ///     address: Address::new(Path::new("skills/review.md")).expect("a UTF-8 path"),
    ///     fingerprint: "0123456789abcdef".to_string(),
    ///     trace: vec![
    ///         "/home/someone/.rigger/store/acme-skill".to_string(),
    ///         "link".to_string(),
    ///         "0123456789abcdef".to_string(),
    ///     ],
    /// });
    /// assert_eq!(
    ///     entry.at(),
    ///     std::path::Path::new("/home/someone/.claude/skills/review.md"),
    /// );
    /// ```
    ///
    /// Handing it the path itself does not compile, which is what keeps the
    /// check from being one a caller has to remember:
    ///
    /// ```compile_fail
    /// use rigger_registry::{Address, Entry, Posting};
    /// let _ = Posting {
    ///     id: "acme/skill".to_string(),
    ///     provenance: "acme".to_string(),
    ///     behaviour: "link".to_string(),
    ///     posed_by: "1.5".to_string(),
    ///     root: "/home/someone/.claude".to_string(),
    ///     address: "skills/review.md".to_string(),
    ///     fingerprint: "0123456789abcdef".to_string(),
    ///     trace: Vec::new(),
    /// };
    /// ```
    pub fn posted(posting: Posting) -> Self {
        Self {
            identity: Identity {
                provenance: posting.provenance,
                id: posting.id,
            },
            behaviour: posting.behaviour,
            posed_by: posting.posed_by,
            root: posting.root,
            address: posting.address,
            fingerprint: posting.fingerprint,
            trace: posting.trace,
            // A pose writes what this build knows and nothing else. Fields it
            // does not know arrive only by reading a document somebody else
            // wrote.
            unknown: Vec::new(),
        }
    }

    /// What names this record: the catalogue it came from **and** what that
    /// catalogue called it. It is what the registry looks a record up by, and
    /// the reason is written on [`Identity`].
    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    /// What the catalogue called this thing. On its own it names no record: two
    /// catalogues may carry this same name.
    pub fn id(&self) -> &str {
        &self.identity.id
    }

    /// Which catalogue it came from.
    pub fn provenance(&self) -> &str {
        &self.identity.provenance
    }

    /// The **name** of the behaviour that posed it, unresolved.
    pub fn behaviour(&self) -> &str {
        &self.behaviour
    }

    /// The version of the product that posed it. Without it, a behaviour that
    /// has since left the closed set is a silence: with it, the refusal can name
    /// which version to go back to.
    pub fn posed_by(&self) -> &str {
        &self.posed_by
    }

    /// The effective root at the moment of the pose.
    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    /// The address, under the root of the pose.
    pub fn address(&self) -> &Path {
        self.address.as_path()
    }

    /// Where it actually is: the address, resolved against the root **this
    /// entry recorded**.
    ///
    /// Never against the root the environment names now. A machine whose root
    /// is overridden between the pose and the removal would otherwise be
    /// searched at the wrong place: nothing would be found, the entry would come
    /// out of the registry all the same, and the files would stay — a dirty
    /// machine that believes itself clean, which is the one outcome this
    /// registry exists to prevent.
    pub fn at(&self) -> PathBuf {
        self.root.as_path().join(self.address.as_path())
    }

    /// The fingerprint of the bytes that were posed.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// The inverse, in the fields the behaviour that posed it writes. The
    /// registry does not read them; the behaviour does, once it has been
    /// resolved.
    pub fn trace(&self) -> &[String] {
        &self.trace
    }

    /// The fields of this record that this build does not know, in the order the
    /// document carried them. See [`UnknownField`] for what is and is not
    /// promised about them.
    pub fn unknown_fields(&self) -> &[UnknownField] {
        &self.unknown
    }

    /// Takes on the fields `held` carries and this one does not.
    ///
    /// Nothing is overwritten: a name this record already carries is what this
    /// run states about it, and the reason it wins is written where the carrying
    /// is decided.
    fn carry_unknown_from(&mut self, held: &Entry) {
        for field in &held.unknown {
            if self.unknown.iter().any(|mine| mine.name == field.name) {
                continue;
            }
            self.unknown.push(field.clone());
        }
    }

    /// The refusal this entry is owed when its behaviour is not one this build
    /// carries — built here, where every field it names is at hand.
    fn behaviour_gone(&self) -> RegistryError {
        RegistryError::BehaviourGone {
            behaviour: self.behaviour.clone(),
            posed_by: self.posed_by.clone(),
            address: self.at(),
            trace: self.trace.clone(),
        }
    }

    /// The line this record is written as.
    ///
    /// **The order is fixed**: the names this build knows, always in this order,
    /// then the fields it does not, in the order the document carried them.
    /// Tests compare registry files byte for byte, and a rendering whose order
    /// came from a map would differ from one run to the next.
    fn render(&self) -> String {
        let mut line = format!(
            "{ENTRY}\t{}={}\t{}={}\t{}={}\t{}={}\t{}={}\t{}={}\t{}={}",
            field::ID,
            escape(&self.identity.id),
            field::PROVENANCE,
            escape(&self.identity.provenance),
            field::BEHAVIOUR,
            escape(&self.behaviour),
            field::POSED_BY,
            escape(&self.posed_by),
            field::ROOT,
            // Not a lossy conversion, and there is nowhere left to put one: the
            // root and the address were checked when they were built.
            escape(self.root.as_str()),
            field::ADDRESS,
            escape(self.address.as_str()),
            field::FINGERPRINT,
            escape(&self.fingerprint),
        );
        if !self.trace.is_empty() {
            line.push('\t');
            line.push_str(field::TRACE);
            line.push('=');
            line.push_str(&escape(&join_trace(&self.trace)));
        }
        for unknown in &self.unknown {
            line.push('\t');
            line.push_str(&unknown.name);
            line.push('=');
            line.push_str(&escape(&unknown.value));
        }
        line
    }
}

/// The behaviour this entry was posed through, or a refusal that names what
/// cannot be done about it.
///
/// # What this is for
///
/// The closed set of behaviours may **shrink** between two versions of the
/// product, and it must never shrink in silence. When a record names a behaviour
/// the running version no longer carries, the product refuses by naming four
/// things — the behaviour as the record spells it, the version that posed it,
/// the file, and what the record holds to be undone by hand — and it never
/// recognises the shape of what is on the disk in order to undo it anyway.
///
/// **No fallback, no neighbour, no default.** Trying a behaviour that resembles
/// the one recorded is the recognition cascade this product removed: it ended in
/// an undefined return, which is a thing posed that nothing could remove. A name
/// that does not resolve is where the removal stops, not where a guess starts.
///
/// **What "to be undone by hand" can honestly be.** An unresolved behaviour does
/// not read its own trace back, so what is handed over is what the entry holds —
/// the file, and the recorded fields as they were written. Naming the keys a
/// merge put into a document would mean reading a trace this build has no reader
/// for, which is the same recognition of shapes under another name.
///
/// # Why the success value is a bare member
///
/// It is [`BehaviourName`] and nothing beside it, and that is the decision
/// rather than a shortcut. A record posed by a version older than this one, in a
/// behaviour this one still carries, resolves — there is nowhere in this return
/// value to put a remark about the version, so a build that wanted to warn about
/// one would have to change the type first. The product has no warning channel
/// at all, and this is the shape that keeps it from growing one here by
/// accident.
///
/// # Why it lives in this crate
///
/// It needs [`Entry`] and [`BehaviourName`] in the same place, and this crate is
/// the only one that sees both: the crate that carries the removal does not know
/// what an entry is, and the crate that declares the closed set is below it. The
/// resolution is pure and would sit happily there on that count alone — what
/// forbids it is that [`Entry`] would have to travel down against an existing
/// arrow.
pub fn resolve_behaviour(entry: &Entry) -> Result<BehaviourName, RegistryError> {
    // The only refusal `parse` makes is that the name is outside the set, and it
    // carries nothing this refusal does not already have from the entry itself.
    BehaviourName::parse(entry.behaviour()).map_err(|_| entry.behaviour_gone())
}

/// A line of the registry that could not be read as an entry.
///
/// It carries **its reason**, in the type and not optionally: a report that says
/// only "unjudgeable" tells its reader nothing they can act on, and an optional
/// reason is a reason that will one day be absent.
///
/// It also carries the line itself, which is not for display: it is what gets
/// written back on the next write, unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unjudgeable {
    line: usize,
    reason: String,
    raw: String,
}

impl Unjudgeable {
    /// Which line of the registry it was, counting from one.
    pub fn line(&self) -> usize {
        self.line
    }

    /// Why it could not be read.
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

/// A registry, read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ledger {
    entries: Vec<Entry>,
    unjudgeable: Vec<Unjudgeable>,
}

impl Ledger {
    /// The registry of a machine nothing has been posed on.
    pub fn empty() -> Self {
        Self::default()
    }

    /// The entries that were read.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// The lines that could not be read, each with its reason.
    pub fn unjudgeable(&self) -> &[Unjudgeable] {
        &self.unjudgeable
    }

    /// Puts `entry` in, replacing whatever was recorded under the same
    /// [`Identity`] — the catalogue **and** the name, never the name alone.
    ///
    /// Pure, and that is what lets the mutations of a run be replayed onto a
    /// registry re-read under the lock rather than written over it.
    ///
    /// **The fields this build does not know travel from the record being
    /// replaced onto the one replacing it**, and without that the promise the
    /// additive regime makes at the read is undone at the very next write. A
    /// build re-posing an identity would drop an annotation a newer build had
    /// written, silently, with nothing reported — and no caller could prevent
    /// it: [`Posting`] has no field to put one in, and [`UnknownField`] cannot
    /// be built outside this module. The loss would be unavoidable by
    /// construction, on the ordinary path, which is the worst place for it.
    ///
    /// **Preserving is not interpreting.** Nothing here reads such a field; this
    /// refuses to destroy what this build did not write, which is the rule the
    /// whole crate is shaped around, applied to its own format.
    ///
    /// **And the argument against is written here rather than left out.**
    /// Carrying the field asserts, implicitly, that it still holds of the pose
    /// just made — while nothing here knows what it says, and it may have
    /// described the pose before. That uncertainty is preferred to a certain
    /// destruction: the choice is between those two, and not between either of
    /// them and being right.
    ///
    /// **A name the incoming record already carries is left as it is.** There
    /// are two sources for it then, and the incoming one is what this run
    /// states; replacing it with the older value would be deciding what the
    /// field means, which is the one thing this rule refuses to do.
    pub fn upsert(&mut self, mut entry: Entry) {
        match self
            .entries
            .iter_mut()
            .find(|held| held.identity == entry.identity)
        {
            Some(held) => {
                entry.carry_unknown_from(held);
                *held = entry;
            }
            None => self.entries.push(entry),
        }
    }

    /// Takes out the entry recorded under this [`Identity`], if there is one.
    /// The record of another catalogue's entry of the same name stays: it
    /// describes other files, and nothing else describes them.
    pub fn remove(&mut self, identity: &Identity) {
        self.entries.retain(|entry| &entry.identity != identity);
    }

    /// Whether anything else the registry records still designates the shared
    /// store entry `store`, once `besides` is taken out.
    ///
    /// **The count is a question about the registry, never about the disk.**
    /// Counting the links found on a machine would be a second description of
    /// the same fact, and two descriptions drift: the day they did, either a
    /// store entry would be taken away while something still designated it, or
    /// it would be kept forever with nobody able to say why.
    ///
    /// **An entry whose trace this build cannot read counts as a referent.**
    /// The two errors are not symmetric. Keeping a store entry nobody
    /// designates wastes a file somebody can delete; taking away one that is
    /// still designated leaves links on the machine pointing at nothing, and
    /// the thing they pointed at is gone. So an unreadable trace is treated as
    /// possibly designating it, and that is written here rather than left to
    /// the shape of an `unwrap_or`.
    ///
    /// **A line this build could not read at all counts as one too**, and for
    /// that same reason rather than out of caution. Such a line is kept in the
    /// file precisely because it describes something posed, and nothing here
    /// can say what: counting only the lines that read would take a
    /// materialisation away while an illegible line still designated it, which
    /// is the identical damage one step further out.
    ///
    /// **So a behaviour outside the closed set is swallowed here and refused by
    /// [`resolve_behaviour`], and the two answers are meant to differ.** The
    /// question this asks is whether a shared store entry may be taken away, and
    /// the safe answer to "I cannot tell" is "somebody may still need it". The
    /// question the refusal answers is whether *this* record may be undone, and
    /// the safe answer to the same doubt is to stop and name it. Made to agree,
    /// one of the two would have to become unsafe: either an unreadable line
    /// stops counting and a materialisation is destroyed under it, or counting
    /// referents starts failing and a removal that has nothing to do with the
    /// bad line cannot proceed.
    pub fn referents(&self, store: &Path, besides: &Identity) -> Referents {
        let still = self
            .entries
            .iter()
            .filter(|entry| entry.identity() != besides)
            .any(|entry| {
                match BehaviourName::parse(entry.behaviour())
                    .and_then(|name| replay(name, entry.trace()))
                {
                    Ok(trace) => trace.store() == Some(store),
                    Err(_) => true,
                }
            });
        if still || !self.unjudgeable.is_empty() {
            Referents::Remaining
        } else {
            Referents::Last
        }
    }

    /// The document this registry is written as.
    ///
    /// Unreadable lines come back out, whole and in order after the entries: a
    /// write that dropped them would destroy the description of something posed,
    /// and make it permanently unremovable.
    pub(crate) fn render(&self) -> String {
        let mut document = format!("{MARKER} {FORMAT_VERSION}\n");
        for entry in &self.entries {
            document.push_str(&entry.render());
            document.push('\n');
        }
        for unreadable in &self.unjudgeable {
            document.push_str(&unreadable.raw);
            document.push('\n');
        }
        document
    }

    /// Reads a registry document.
    ///
    /// The envelope decides whether there is anything to read at all; each line
    /// after it is decoded on its own, so one that fails costs one entry.
    ///
    /// **Decoding is not [`Ledger::upsert`], and the difference is a whole
    /// class of loss.** Replacing on a repeated identifier is what a *mutation*
    /// means — the run says this thing is now posed there. It is not what a
    /// *line* means: two lines under one identifier are a registry this build
    /// did not write, and nothing here can tell which of them describes what
    /// was posed. Folded together, the first is dropped at the read and its
    /// line disappears from the file at the next write — a readable line
    /// treated worse than an illegible one, which is kept byte for byte
    /// precisely so that what it describes stays removable. So the second and
    /// any further line under an identifier already read are unjudgeable, with
    /// a reason naming the identifier and the line that already carried it, and
    /// they come back out unchanged.
    pub(crate) fn parse(path: &Path, document: &str) -> Result<Self, RegistryError> {
        let mut lines = document.lines();
        let envelope = lines.next().ok_or_else(|| RegistryError::EnvelopeMissing {
            path: path.to_path_buf(),
        })?;
        let mut fields = envelope.split(' ');
        if fields.next() != Some(MARKER) {
            return Err(RegistryError::EnvelopeMissing {
                path: path.to_path_buf(),
            });
        }
        let found = fields
            .next()
            .ok_or_else(|| RegistryError::EnvelopeMissing {
                path: path.to_path_buf(),
            })?
            .to_string();
        if found != FORMAT_VERSION.to_string() {
            return Err(RegistryError::EnvelopeUnknown {
                path: path.to_path_buf(),
                found,
                expected: FORMAT_VERSION,
            });
        }

        let mut ledger = Self::empty();
        // Which line first carried each identity, so a repeat can name it. It is
        // the identity and not the name alone: two catalogues carrying an entry
        // of the same name are two records, and reporting the second unjudgeable
        // would make a legitimate registry unreadable by half.
        let mut carried: Vec<(Identity, usize)> = Vec::new();
        for (index, line) in lines.enumerate() {
            // The envelope is line one, and `lines` started after it.
            let number = index + 2;
            if line.trim().is_empty() {
                continue;
            }
            let (reason, entry) = match decode_entry(line) {
                Ok(entry) => {
                    let already = carried
                        .iter()
                        .find(|(identity, _)| identity == entry.identity())
                        .map(|(_, first)| *first);
                    match already {
                        Some(first) => (
                            format!(
                                "{} is already recorded on line {first}, and nothing here can tell \
                                 which of the two describes what was posed",
                                entry.identity()
                            ),
                            None,
                        ),
                        None => (String::new(), Some(entry)),
                    }
                }
                Err(reason) => (reason, None),
            };
            match entry {
                Some(entry) => {
                    carried.push((entry.identity().clone(), number));
                    ledger.entries.push(entry);
                }
                None => ledger.unjudgeable.push(Unjudgeable {
                    line: number,
                    reason,
                    raw: line.to_string(),
                }),
            }
        }
        Ok(ledger)
    }
}

/// One entry, or why this line is not one. The reason travels; it is what the
/// unjudgeable state has to name.
///
/// **Reading does not depend on the order of the fields**, and that is the half
/// that makes the format extensible rather than merely renamed. A build reads
/// the names it knows wherever they are, so a newer build may write them in any
/// order, and inserting a field is not a change to what any other field means.
///
/// **Three malformations make the line unjudgeable rather than being tidied
/// up**, and each of them keeps the bytes: an unjudgeable line is written back
/// exactly as it was read.
///
/// A field carrying no `=` is not a field of this format. Ignoring it would take
/// it out of the file at the next write, which is the loss this whole format
/// exists against, on the likeliest case there is — a line written in some other
/// format altogether.
///
/// A name written twice is refused because nothing here can say which of the two
/// describes what was posed. Taking the last, or the first, would be choosing at
/// random between two descriptions of a thing on somebody's machine.
///
/// A required name that is absent is refused **by naming it**, and never
/// completed from a default: a default is a value nobody wrote, and a removal
/// computed from one acts somewhere nobody consented to.
fn decode_entry(line: &str) -> Result<Entry, String> {
    let mut fields = line.split('\t');
    match fields.next() {
        Some(ENTRY) => {}
        Some(other) => {
            return Err(format!(
                "the line opens with `{other}`, and the only record this build reads is `{ENTRY}`"
            ))
        }
        None => return Err("the line is empty".to_string()),
    }

    // The names as the document spells them, with their values still escaped,
    // in the order they were read — which is the order the unknown ones are
    // written back in.
    let mut written: Vec<(&str, &str)> = Vec::new();
    for field in fields {
        // **At the first `=` and never the last.** A value carries them: a root
        // may legitimately be a directory called `env=prod`, and every path this
        // registry accepts is a path. Cutting at the last one reads back a
        // different address, and a removal then looks where nothing was posed.
        let Some((name, value)) = field.split_once('=') else {
            return Err(format!(
                "the field `{field}` carries no `=`, and every field of an entry is a name and a \
                 value"
            ));
        };
        if name.is_empty() {
            return Err(format!(
                "the field `{field}` opens with `=`, and the name of a field is never empty"
            ));
        }
        if written.iter().any(|(already, _)| *already == name) {
            return Err(format!(
                "the field `{name}` is written twice, and nothing here can tell which of the two \
                 describes what was posed"
            ));
        }
        written.push((name, value));
    }

    let value = |name: &str| -> Option<&str> {
        written
            .iter()
            .find(|(written, _)| *written == name)
            .map(|(_, value)| *value)
    };
    let read = |name: &str, what: &str| -> Result<String, String> {
        let raw = value(name).ok_or_else(|| format!("the line carries no {what}"))?;
        unescape(raw).map_err(|reason| format!("the {what} cannot be read — {reason}"))
    };

    let mut unknown = Vec::new();
    for (name, raw) in &written {
        if field::KNOWN.contains(name) {
            continue;
        }
        if name.starts_with(DECIDES) {
            return Err(format!(
                "the field `{name}` decides how this record is to be written, and this build does \
                 not carry it — a field of that kind is not one to ignore, because ignoring it \
                 means writing something other than what the record declares"
            ));
        }
        unknown.push(UnknownField {
            name: (*name).to_string(),
            value: unescape(raw)
                .map_err(|reason| format!("the field `{name}` cannot be read — {reason}"))?,
        });
    }

    let id = read(field::ID, "identifier")?;
    let provenance = read(field::PROVENANCE, "provenance")?;
    let behaviour = read(field::BEHAVIOUR, "behaviour name")?;
    let posed_by = read(field::POSED_BY, "posing version")?;
    let root = read(field::ROOT, "effective root")?;
    let address = read(field::ADDRESS, "address")?;
    let fingerprint = read(field::FINGERPRINT, "fingerprint")?;
    // **The trace is not required, and its absence is an empty trace.** A record
    // of something posed through a behaviour that writes no inverse is a
    // legitimate record, and treating the field as required would turn every one
    // of them into an unreadable line.
    //
    // **Its elements are not resolved here**, however many there are. The arity
    // belongs to the behaviour that posed, not to the registry: reading it here
    // would mean resolving the behaviour while decoding, and an entry naming a
    // behaviour this build no longer carries would become a corrupt line
    // reported unjudgeable with the wrong reason — while the refusal that has to
    // name the behaviour, its version and the file never happened.
    let trace = match value(field::TRACE) {
        None => Vec::new(),
        Some(raw) => split_trace(
            &unescape(raw).map_err(|reason| format!("the trace cannot be read — {reason}"))?,
        )?,
    };

    if id.is_empty() {
        return Err("the identifier is empty".to_string());
    }
    // The root and the address came out of a UTF-8 document, so they are ones:
    // no check is possible here, and the one that matters happened where the
    // paths were offered.
    Ok(Entry {
        identity: Identity { provenance, id },
        behaviour,
        posed_by,
        root: Address::from_document(root),
        address: Address::from_document(address),
        fingerprint,
        trace,
        unknown,
    })
}

/// The elements of a trace, written into one field.
///
/// **One field and not one field per element**, because a name written twice
/// makes a line unjudgeable — so `trace=` repeated, the shape a list of variable
/// length asks for, is not available. The other form left was a name per index,
/// `trace.0`, `trace.1`, and it was not taken: it needs rules for a gap, for an
/// index out of order and for one repeated, each of which is a way for two
/// readers to disagree about the same file.
///
/// **The nesting is what makes it unambiguous.** Each element is escaped, the
/// escaped forms are joined with a tabulation, and the whole is escaped again as
/// the value of the field. An escaped element carries no tabulation of its own —
/// that is what the escaping is for — so the tabulations that survive to the
/// join are exactly the ones the join put there. An element that itself holds a
/// tabulation comes back holding it.
fn join_trace(trace: &[String]) -> String {
    trace
        .iter()
        .map(|element| escape(element))
        .collect::<Vec<_>>()
        .join("\t")
}

/// The elements a trace field carries, read back.
///
/// A field that is there with an empty value is **one empty element**, and a
/// field that is not there at all is no elements. The two are different records,
/// and rendering keeps them apart: an empty trace writes no field.
fn split_trace(joined: &str) -> Result<Vec<String>, String> {
    joined
        .split('\t')
        .enumerate()
        .map(|(index, element)| {
            unescape(element).map_err(|reason| {
                format!(
                    "element {} of the trace cannot be read — {reason}",
                    index + 1
                )
            })
        })
        .collect()
}

/// Renders a field so that no value can produce a separator or a line break.
///
/// Without it, an address holding a tabulation would split into two fields and
/// the entry would come back describing a different address — a write to a place
/// nobody consented to, and a removal that misses.
fn escape(field: &str) -> String {
    let mut escaped = String::with_capacity(field.len());
    for character in field.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '\t' => escaped.push_str("\\t"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// Reads a field back. An escape this build does not know is a refusal and never
/// a guess: guessing would return an address that is not the one recorded.
fn unescape(field: &str) -> Result<String, String> {
    let mut read = String::with_capacity(field.len());
    let mut characters = field.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            read.push(character);
            continue;
        }
        match characters.next() {
            Some('\\') => read.push('\\'),
            Some('t') => read.push('\t'),
            Some('n') => read.push('\n'),
            Some('r') => read.push('\r'),
            Some(other) => return Err(format!("`\\{other}` is not an escape this build writes")),
            None => return Err("it ends on an unfinished escape".to_string()),
        }
    }
    Ok(read)
}

/// Why the registry was not read, or not written.
///
/// **Every variant renders from its typed fields only, and none of them has a
/// free-text tail.** That is what makes "the refusal advises no remedy" a
/// property of the shape of a message rather than of its wording: a list of
/// forbidden words does not close the set of ways to advise a remedy, and a test
/// built on one goes green on any rephrasing of the same advice.
///
/// And the advice is not withheld out of terseness. A product that states a
/// remedy it cannot itself carry out under backup manufactures the loss it
/// claims to avoid: told to delete the registry, its owner deletes the
/// description of everything that was posed, and every one of those things
/// becomes unremovable.
#[derive(Debug)]
pub enum RegistryError {
    /// The document carries no envelope. No default version is assumed for it:
    /// assuming one is how a registry of unknown provenance gets read as if it
    /// were ours.
    EnvelopeMissing {
        /// The registry file.
        path: PathBuf,
    },
    /// The envelope declares a format version this build does not read.
    EnvelopeUnknown {
        /// The registry file.
        path: PathBuf,
        /// The version the document declares.
        found: String,
        /// The version this build reads.
        expected: u32,
    },
    /// The registry could not be read from the disk.
    Read {
        /// The registry file.
        path: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
    /// The registry is not UTF-8. Refused rather than read with replacement
    /// bytes, which would silently destroy what they replace.
    NotUtf8 {
        /// The registry file.
        path: PathBuf,
    },
    /// The registry could not be written.
    Write {
        /// The registry file.
        path: PathBuf,
        /// What the system reported.
        detail: io::Error,
    },
    /// The registry is there, its content cannot be rendered, and a run that
    /// would have replaced it handed back instead.
    ///
    /// **It preserves rather than reports.** The file is left exactly as it is,
    /// nothing is written over it, and the caller is handed the path that names
    /// it together with whatever copy of it is beside — the copy an earlier run
    /// left when it was interrupted between taking one and writing.
    ///
    /// **The two paths are typed fields, and that is the point of them.** A
    /// caller handed only a sentence has to parse the files back out of it to
    /// name either one, and a caller that cannot name them cannot offer them:
    /// the copy would be recognised, its content would be there, and nothing
    /// would ever propose it. The classification travels with the path for the
    /// same reason — a path alone says a file is there, not whether restoring it
    /// would restore an amputated registry.
    Unreadable {
        /// The registry, still on the disk and unchanged.
        registry: PathBuf,
        /// Why its content could not be rendered.
        cause: Box<RegistryError>,
        /// The copy beside it, and what reading it is worth.
        backup: Backup,
    },
    /// A record names a behaviour this version of the product no longer carries.
    ///
    /// **The set of behaviours may shrink, and it must never shrink in
    /// silence.** The alternative to this refusal is not a smaller product, it
    /// is a removal that guesses: a behaviour resembling the one recorded is
    /// tried, it undoes something other than what was posed, and it reports
    /// success. So nothing is undone, nothing is taken out of the registry, and
    /// the four things somebody needs in order to act are handed over instead.
    ///
    /// **The recorded fields travel as they were written.** This build has no
    /// reader for them — that is what the refusal is about — so it does not say
    /// what they mean. Naming the keys a merge put into a document would be the
    /// recognition of shapes this product removed, arriving inside the message
    /// that exists to refuse it.
    BehaviourGone {
        /// The behaviour, as the record spells it.
        behaviour: String,
        /// The version of the product that posed it, and which carried that
        /// behaviour. Without it, the refusal names a dead end; with it, it
        /// names the build that can still undo this.
        posed_by: String,
        /// The file it was posed at: the root the record holds, joined with the
        /// address it holds. Never the root the environment names now.
        address: PathBuf,
        /// The inverse, in the fields the behaviour that posed it wrote.
        trace: Vec<String>,
    },
    /// The exclusion the write window holds under was not obtained.
    Locked(LockError),
    /// The lock offered as proof guards another registry.
    ///
    /// A proof of holding is a proof about **one** lock. Accepting one taken
    /// elsewhere would let a run hold the lock of registry A and write registry
    /// B, which is the exclusion doing nothing at all while appearing to work.
    LockElsewhere {
        /// The registry the write was for.
        registry: PathBuf,
        /// The lock that guards it.
        expected: PathBuf,
        /// The lock that was held.
        held: PathBuf,
    },
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EnvelopeMissing { path } => write!(
                f,
                "{}: the registry carries no envelope, so this build cannot tell which format it \
                 was written in — it is left exactly as it is, and no version is assumed for it",
                path.display()
            ),
            Self::EnvelopeUnknown {
                path,
                found,
                expected,
            } => write!(
                f,
                "{}: the registry declares format version {found}, and this build reads version \
                 {expected} — it is left exactly as it is, because it is the only description of \
                 what has been posed on this machine",
                path.display()
            ),
            Self::Read { path, detail } => {
                write!(f, "{}: cannot be read — {detail}", path.display())
            }
            Self::NotUtf8 { path } => write!(
                f,
                "{}: the registry is not UTF-8 — it is left exactly as it is, rather than read with \
                 replacement bytes that would destroy what they replace",
                path.display()
            ),
            Self::Write { path, detail } => {
                write!(f, "{}: cannot be written — {detail}", path.display())
            }
            // The cause already names the registry and says it was left alone;
            // what this adds is what is beside it. Neither half has a free-text
            // tail, so neither can grow into advice to delete the file.
            Self::Unreadable { cause, backup, .. } => write!(f, "{cause}; {backup}"),
            Self::BehaviourGone {
                behaviour,
                posed_by,
                address,
                trace,
            } => write!(
                f,
                "{}: posed through behaviour `{behaviour}` by version {posed_by} of the product, \
                 and this build carries no behaviour of that name — nothing was undone, the \
                 record is left exactly as it is, and no neighbouring behaviour was tried in its \
                 place; what the record holds, to be undone by hand, is [{}]",
                address.display(),
                as_recorded(trace)
            ),
            Self::Locked(err) => write!(f, "{err}"),
            Self::LockElsewhere {
                registry,
                expected,
                held,
            } => write!(
                f,
                "{}: the exclusion held is {}, and the one that guards this registry is {} — \
                 nothing was written",
                registry.display(),
                held.display(),
                expected.display()
            ),
        }
    }
}

/// The recorded fields, each quoted, in the order they were written.
///
/// **One rendering and not two.** A branch for "no fields at all" would be a
/// second output nothing pins, and the guard that pins these one by one would
/// not know to look for it; an empty list renders as an empty list.
fn as_recorded(trace: &[String]) -> String {
    trace
        .iter()
        .map(|field| format!("`{field}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

impl std::error::Error for RegistryError {}

impl From<LockError> for RegistryError {
    fn from(err: LockError) -> Self {
        Self::Locked(err)
    }
}

/// The code a command exits with when the request could not be satisfied and the
/// caller has to change what they asked for — an unknown flag, an identifier
/// that names nothing.
///
/// It is declared here, next to the refusals of the registry, and not because
/// this crate owns the command surface. It is declared here so the two families
/// can be compared in one place: A1 requires that a registry this build refuses
/// to read be **distinguishable, by exit code, from a usage error**, and two
/// codes chosen in two files drift into each other without anything going red.
pub const IMPOSSIBLE_REQUEST: u8 = 2;

/// The code a command exits with when the request was legitimate and the run
/// failed — the caller retries, or looks at their machine.
pub const RUNTIME_FAILURE: u8 = 1;

/// What a command exits with on a refusal of the registry.
///
/// It is a function of the library and not of the command surface, which is what
/// lets the requirement be measured before a command surface exists. Every arm
/// is written out: a variant added later does not build until somebody decides
/// which of the two families it belongs to.
///
/// Every arm today answers [`RUNTIME_FAILURE`], and that is not an oversight.
/// None of these refusals is something the caller mistyped: the registry is
/// there and this build cannot read it, or another run holds it. What A1 demands
/// is the one thing this must never do — answer [`IMPOSSIBLE_REQUEST`], which is
/// what a mistyped command answers, and thereby tell a script that a registry it
/// cannot read is the same event as a bad flag.
pub fn exit_code(err: &RegistryError) -> u8 {
    match err {
        RegistryError::EnvelopeMissing { .. } => RUNTIME_FAILURE,
        RegistryError::EnvelopeUnknown { .. } => RUNTIME_FAILURE,
        RegistryError::Read { .. } => RUNTIME_FAILURE,
        RegistryError::NotUtf8 { .. } => RUNTIME_FAILURE,
        RegistryError::Write { .. } => RUNTIME_FAILURE,
        // The registry is there and this build cannot read it. Nothing about
        // that is a request the caller could restate, so answering
        // `IMPOSSIBLE_REQUEST` would tell a script it had mistyped something and
        // send it round the same loop for ever.
        RegistryError::Unreadable { .. } => RUNTIME_FAILURE,
        // The record is what an older build wrote, and no wording of the request
        // makes this build carry a behaviour it does not. Answering
        // `IMPOSSIBLE_REQUEST` would tell a script it had asked for the wrong
        // thing, and send it round the same loop for ever with the entry still
        // in place.
        RegistryError::BehaviourGone { .. } => RUNTIME_FAILURE,
        RegistryError::Locked(_) => RUNTIME_FAILURE,
        RegistryError::LockElsewhere { .. } => RUNTIME_FAILURE,
    }
}
