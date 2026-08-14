//! Reads one entry's descriptor out of a catalogue — the plumbing `install`
//! needs before it can pose anything, and nothing past that.
//!
//! **Hard-coded to the one shape a real catalogue carries today**, per this
//! change's mandate: a `format = 1` marker at the document's root, and a flat
//! `[[entries]]` array whose members carry `kind`, `id` and `nature` as
//! strings. A future format is not read here — `jr-agent-rigger-catalog`'s own
//! contract still carries open questions about how an entry is found by id at
//! all, and this reader answers none of them; it reads the one document that
//! exists.

use std::fmt;
use std::path::{Path, PathBuf};

use toml_edit::DocumentMut;

/// The format marker this reader recognises. A catalogue declaring another
/// value is refused by naming it, rather than read as though it were this
/// one.
const KNOWN_FORMAT: i64 = 1;

/// The fields `install` needs out of one `[[entries]]` member, plus the
/// catalogue's own name — read from `[meta].name` — which is what
/// [`rigger_registry::Identity::provenance`] records: two catalogues may
/// legitimately carry an entry under the same id, and the registry tells
/// their records apart by this, never by the id alone.
pub struct Descriptor {
    pub kind: String,
    pub id: String,
    pub nature: String,
    pub catalogue: String,
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

    Ok(Descriptor {
        kind: field("kind")?,
        id: field("id")?,
        nature: field("nature")?,
        catalogue,
    })
}
