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
//! # An absent registry is empty; a malformed one is not
//!
//! Nothing has been posed on a machine where the file does not exist, and
//! reading it as empty describes that machine correctly. A file that is there
//! and does not read is a machine we know nothing about, and the two are not the
//! same observation. Every refusal below exists to keep them apart.

use std::fmt;
use std::io;
use std::path::PathBuf;

use rigger_apply::LockError;

/// The marker every registry document opens with.
pub(crate) const MARKER: &str = "rigger-registry";

/// The envelope version this build writes and reads.
pub(crate) const FORMAT_VERSION: u32 = 1;

/// The word that opens an entry's line.
const ENTRY: &str = "entry";

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
    id: String,
    behaviour: String,
    posed_by: String,
    address: PathBuf,
}

impl Entry {
    /// Records `id` as posed at `address` by the behaviour named `behaviour`,
    /// by the version `posed_by` of the product.
    pub fn new(
        id: impl Into<String>,
        behaviour: impl Into<String>,
        posed_by: impl Into<String>,
        address: impl Into<PathBuf>,
    ) -> Self {
        Self {
            id: id.into(),
            behaviour: behaviour.into(),
            posed_by: posed_by.into(),
            address: address.into(),
        }
    }

    /// What the catalogue called this thing.
    pub fn id(&self) -> &str {
        &self.id
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

    /// Where it was posed.
    pub fn address(&self) -> &std::path::Path {
        &self.address
    }

    fn render(&self) -> String {
        format!(
            "{ENTRY}\t{}\t{}\t{}\t{}",
            escape(&self.id),
            escape(&self.behaviour),
            escape(&self.posed_by),
            escape(&self.address.to_string_lossy()),
        )
    }
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

    /// Puts `entry` in, replacing whatever carried the same identifier.
    ///
    /// Pure, and that is what lets the mutations of a run be replayed onto a
    /// registry re-read under the lock rather than written over it.
    pub fn upsert(&mut self, entry: Entry) {
        match self.entries.iter_mut().find(|held| held.id == entry.id) {
            Some(held) => *held = entry,
            None => self.entries.push(entry),
        }
    }

    /// Takes out the entry with this identifier, if there is one.
    pub fn remove(&mut self, id: &str) {
        self.entries.retain(|entry| entry.id != id);
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
    pub(crate) fn parse(path: &std::path::Path, document: &str) -> Result<Self, RegistryError> {
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
        for (index, line) in lines.enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            match decode_entry(line) {
                Ok(entry) => ledger.upsert(entry),
                Err(reason) => ledger.unjudgeable.push(Unjudgeable {
                    // The envelope is line one, and `lines` started after it.
                    line: index + 2,
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
    let mut read = |what: &str| -> Result<String, String> {
        let field = fields
            .next()
            .ok_or_else(|| format!("the line carries no {what}"))?;
        unescape(field).map_err(|reason| format!("the {what} cannot be read — {reason}"))
    };
    let id = read("identifier")?;
    let behaviour = read("behaviour name")?;
    let posed_by = read("posing version")?;
    let address = read("address")?;
    if let Some(extra) = fields.next() {
        return Err(format!(
            "the line carries a field this build does not read — `{extra}`"
        ));
    }
    if id.is_empty() {
        return Err("the identifier is empty".to_string());
    }
    Ok(Entry::new(id, behaviour, posed_by, address))
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
        RegistryError::Locked(_) => RUNTIME_FAILURE,
        RegistryError::LockElsewhere { .. } => RUNTIME_FAILURE,
    }
}
