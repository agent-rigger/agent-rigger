//! Reads one entry's descriptor out of a catalogue — the plumbing `install`
//! needs before it can pose anything.
//!
//! **Hard-coded to the one shape a real catalogue carries today**, per this
//! change's mandate: a `format = 1` marker at the document's root, and a flat
//! `[[entries]]` array whose members carry `kind`, `id` and `nature` as
//! strings, plus an optional `path`. A future format is not read here —
//! `jr-agent-rigger-catalog`'s own contract still carries open questions
//! about how an entry is found by id at all, and this reader answers none of
//! them; it reads the one document that exists.
//!
//! It also carries [`NATURE_TABLE`] — ADR-0048's rule for where a nature's
//! artefact sits under the catalogue root, absent a `path` override. Turning
//! that table, and an entry's own `path`, into a confined location on disk is
//! [`crate::source::resolve`]'s job, not this module's: this one only reads
//! what the catalogue says, and names the rule the nature alone implies.

use std::fmt;
use std::path::{Path, PathBuf};

use toml_edit::{DocumentMut, Item};

/// The format marker this reader recognises. A catalogue declaring another
/// value is refused by naming it, rather than read as though it were this
/// one.
const KNOWN_FORMAT: i64 = 1;

/// Where a nature's artefact sits, relative to the folder its own row in
/// [`NATURE_TABLE`] names — and, reused for [`Descriptor::disposition`], the
/// shape an entry declares for itself, overriding that default for this one
/// entry alone (ADR-0049 § 4, which amends ADR-0048 § 1 the same way `path`
/// already overrides the nature's default folder).
///
/// **An entry's own override never carries an extension.** `NATURE_TABLE`'s
/// own rows always do, because they name a *default* filename shape for a
/// nature that has never needed anything else; an entry overriding to
/// `Disposition::File` is naming the shape alone, and a bare `<local id>` is
/// that shape's honest reading. An entry that needs a specific extension
/// names one through `path` instead (ADR-0048 § 2) — the exact file, which is
/// a different question from the shape of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// A file — `<local id>.<extension>` when an extension is named, bare
    /// `<local id>` when `extension` is empty.
    File { extension: &'static str },
    /// A directory named `<local id>`.
    Directory,
}

/// nature → (folder under the catalogue root, disposition of what is
/// there). ADR-0048: measured 2026-08-14 against the 53 artefact entries of
/// the reference catalogue — 51 follow `<folder>/<local id>` exactly as this
/// table says, and the two that do not (`context:claude`, whose file name
/// derives from nothing, and `guardrail:claude`, which names two files) each
/// carry an explicit `path` on their own entry, which
/// [`crate::source::resolve`] honours ahead of this table entirely. A
/// nature this table does not list is refused by name, not guessed at.
pub const NATURE_TABLE: &[(&str, &str, Disposition)] = &[
    ("hook", "hooks", Disposition::File { extension: "ts" }),
    ("agent", "agents", Disposition::File { extension: "md" }),
    ("skill", "skills", Disposition::Directory),
    (
        "workflow",
        "workflows",
        Disposition::File { extension: "js" },
    ),
    ("lib", "libs", Disposition::Directory),
    (
        "guardrail",
        "guardrails",
        Disposition::File { extension: "json" },
    ),
    ("context", "contexts", Disposition::File { extension: "md" }),
];

/// The folder and disposition [`NATURE_TABLE`] names for `nature`, or
/// `None` when `nature` is not one this reader knows.
pub fn nature_location(nature: &str) -> Option<(&'static str, Disposition)> {
    NATURE_TABLE
        .iter()
        .find(|(known, _, _)| *known == nature)
        .map(|(_, folder, disposition)| (*folder, *disposition))
}

/// The fields `install` needs out of one `[[entries]]` member, plus the
/// catalogue's own name — read from `[meta].name` — which is what
/// [`rigger_registry::Identity::provenance`] records: two catalogues may
/// legitimately carry an entry under the same id, and the registry tells
/// their records apart by this, never by the id alone.
///
/// `kind` is not carried here — nothing downstream of this reader consumes
/// it — but [`read`] still requires the entry to carry one as a string,
/// unchanged from before this struct's own `path` was added: an entry
/// missing it fails the same way it always did.
pub struct Descriptor {
    pub id: String,
    pub nature: String,
    pub catalogue: String,
    /// The entry's own `path`, when it carries one — a string or an array
    /// of strings in the catalogue, always read back as a list. Overrides
    /// [`NATURE_TABLE`]'s rule for this one entry (ADR-0048 § 2).
    pub path: Option<Vec<String>>,
    /// The entry's own disposition, when it declares one — `"file"` or
    /// `"directory"` in the catalogue, and nothing else. Overrides
    /// [`NATURE_TABLE`]'s default disposition for this one entry
    /// (ADR-0049 § 4).
    pub disposition: Option<Disposition>,
}

/// Why a descriptor could not be read.
#[derive(Debug)]
pub enum DescriptorError {
    /// The catalogue file could not be read from the disk.
    Read {
        path: PathBuf,
        detail: std::io::Error,
    },
    /// The catalogue is not UTF-8, so it is not a TOML document this reader
    /// can parse.
    NotUtf8 { path: PathBuf },
    /// The catalogue does not parse as TOML at all.
    Malformed {
        path: PathBuf,
        detail: toml_edit::TomlError,
    },
    /// The catalogue's root carries no `format` marker, or one this reader
    /// does not recognise.
    UnknownFormat { path: PathBuf, found: Option<i64> },
    /// No `[[entries]]` member of this catalogue carries `id`.
    NotFound { path: PathBuf, id: String },
    /// The entry named `id` exists, but one of the fields this reader
    /// requires — `kind`, `id` or `nature`, each a string — is absent or not
    /// a string.
    MissingField {
        path: PathBuf,
        id: String,
        field: &'static str,
    },
    /// The entry named `id` carries a `path` field that is neither a
    /// string nor an array whose members are all strings — the two shapes
    /// ADR-0048 § 2 accepts.
    InvalidPath { path: PathBuf, id: String },
    /// The entry named `id` carries a `disposition` field that is neither
    /// `"file"` nor `"directory"` — the two words ADR-0049 § 4 accepts.
    InvalidDisposition { path: PathBuf, id: String },
}

impl fmt::Display for DescriptorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, detail } => {
                write!(f, "{}: cannot read the catalogue — {detail}", path.display())
            }
            Self::NotUtf8 { path } => {
                write!(f, "{}: the catalogue is not UTF-8", path.display())
            }
            Self::Malformed { path, detail } => {
                write!(f, "{}: the catalogue does not parse as TOML — {detail}", path.display())
            }
            Self::UnknownFormat { path, found: Some(found) } => write!(
                f,
                "{}: this reader knows `format = {KNOWN_FORMAT}`, and the catalogue declares `{found}`",
                path.display()
            ),
            Self::UnknownFormat { path, found: None } => write!(
                f,
                "{}: the catalogue carries no `format` marker at its root",
                path.display()
            ),
            Self::NotFound { path, id } => {
                write!(f, "{}: no entry named `{id}` in this catalogue", path.display())
            }
            Self::MissingField { path, id, field } => write!(
                f,
                "{}: entry `{id}` carries no string field `{field}`",
                path.display()
            ),
            Self::InvalidPath { path, id } => write!(
                f,
                "{}: entry `{id}` carries a `path` field that is neither a string nor an array of \
                 strings",
                path.display()
            ),
            Self::InvalidDisposition { path, id } => write!(
                f,
                "{}: entry `{id}` carries a `disposition` field that is neither `\"file\"` nor \
                 `\"directory\"`",
                path.display()
            ),
        }
    }
}

impl std::error::Error for DescriptorError {}

/// The descriptor of the entry named `id`, read out of the catalogue at
/// `path`.
pub fn read(path: &Path, id: &str) -> Result<Descriptor, DescriptorError> {
    let bytes = std::fs::read(path).map_err(|detail| DescriptorError::Read {
        path: path.to_path_buf(),
        detail,
    })?;
    let text = String::from_utf8(bytes).map_err(|_| DescriptorError::NotUtf8 {
        path: path.to_path_buf(),
    })?;
    let document: DocumentMut = text.parse().map_err(|detail| DescriptorError::Malformed {
        path: path.to_path_buf(),
        detail,
    })?;
    let root = document.as_table();

    let format = root.get("format").and_then(|item| item.as_integer());
    if format != Some(KNOWN_FORMAT) {
        return Err(DescriptorError::UnknownFormat {
            path: path.to_path_buf(),
            found: format,
        });
    }

    let catalogue = root
        .get("meta")
        .and_then(|item| item.as_table())
        .and_then(|meta| meta.get("name"))
        .and_then(|item| item.as_str())
        .unwrap_or_else(|| path.to_str().unwrap_or("catalogue"))
        .to_string();

    let entries = root
        .get("entries")
        .and_then(|item| item.as_array_of_tables());
    let found = entries
        .into_iter()
        .flatten()
        .find(|entry| entry.get("id").and_then(|item| item.as_str()) == Some(id));

    let entry = found.ok_or_else(|| DescriptorError::NotFound {
        path: path.to_path_buf(),
        id: id.to_string(),
    })?;

    let field = |name: &'static str| -> Result<String, DescriptorError> {
        entry
            .get(name)
            .and_then(|item| item.as_str())
            .map(str::to_string)
            .ok_or(DescriptorError::MissingField {
                path: path.to_path_buf(),
                id: id.to_string(),
                field: name,
            })
    };

    field("kind")?;
    let entry_id = field("id")?;
    // Captured before the `path` identifier below shadows the parameter with
    // the entry's own `path` field — every error from here on names the
    // catalogue file, not that field, and needs the parameter's value.
    let catalogue_path = path.to_path_buf();
    let path = match entry.get("path") {
        None => None,
        Some(item) => Some(
            read_path_field(item).ok_or_else(|| DescriptorError::InvalidPath {
                path: catalogue_path.clone(),
                id: entry_id.clone(),
            })?,
        ),
    };
    let disposition = match entry.get("disposition") {
        None => None,
        Some(item) => Some(read_disposition_field(item).ok_or_else(|| {
            DescriptorError::InvalidDisposition {
                path: catalogue_path.clone(),
                id: entry_id.clone(),
            }
        })?),
    };

    Ok(Descriptor {
        id: entry_id,
        nature: field("nature")?,
        catalogue,
        path,
        disposition,
    })
}

/// Reads a `path` field as either one string or an array of strings — the
/// two shapes ADR-0048 § 2 accepts for an entry's override. `None` when
/// `item` is neither of those two shapes, or when an array member of it is
/// not itself a string.
fn read_path_field(item: &Item) -> Option<Vec<String>> {
    if let Some(single) = item.as_str() {
        return Some(vec![single.to_string()]);
    }
    item.as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect()
}

/// Reads a `disposition` field as the shape it names. `None` when `item` is
/// not a string, or is a string that is neither `"file"` nor `"directory"` —
/// the two words ADR-0049 § 4 accepts for an entry's override.
///
/// The `File` this produces always carries an empty `extension`: a bare
/// `<local id>` is what naming the shape alone, without a `path`, can honestly
/// promise — see [`Disposition`]'s own doc comment for why a specific
/// extension is a different field's job.
fn read_disposition_field(item: &Item) -> Option<Disposition> {
    match item.as_str()? {
        "file" => Some(Disposition::File { extension: "" }),
        "directory" => Some(Disposition::Directory),
        _ => None,
    }
}
