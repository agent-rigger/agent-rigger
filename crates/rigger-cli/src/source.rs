//! Resolves the artefact a catalogue entry names to a location on disk —
//! ADR-0048: the entry's own `path`, when it carries one, ahead of the rule
//! [`crate::descriptor::NATURE_TABLE`] states for its nature, both confined
//! under the catalogue's own root by [`crate::confine`]. ADR-0049 § 4 adds a
//! second override to the nature rule, alongside `path`: an entry may declare
//! its own [`Disposition`], which then wins over the one
//! [`crate::descriptor::NATURE_TABLE`] would have given its nature by
//! default.
//!
//! What this module does not do is turn the result into bytes on a disk
//! `install` poses. [`Source::Directory`] and [`Source::Files`] name a
//! location without reading it — [`crate::install`] is what turns the first
//! into the tree [`rigger_apply::read_tree`] reads, and the second into the
//! small one its own named files form, both planted through
//! [`rigger_plan::Fragment::Tree`] (ADR-0049).

use std::fmt;
use std::path::{Path, PathBuf};

use crate::confine::{self, confine, ConfinementError};
use crate::descriptor::{nature_location, Descriptor, Disposition};

/// The artefact source [`resolve`] found, confined under the catalogue
/// root — still not guaranteed to exist on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// One file to read and pose.
    File(PathBuf),
    /// A whole directory, posed as one indivisible tree —
    /// [`crate::descriptor::Disposition::Directory`] names it, by
    /// [`crate::descriptor::NATURE_TABLE`]'s default or by an entry's own
    /// override (ADR-0049 § 4). [`rigger_plan::Fragment::Tree`] is what a
    /// directory this shape names is posed through.
    Directory(PathBuf),
    /// More than one file, from a `path` array on the entry — planted
    /// together as the small tree they form, each entered under its own
    /// file name. ADR-0049 is what makes this a single address and a single
    /// fingerprint, the same as [`Source::Directory`], rather than a shape
    /// that would need [`rigger_registry::Posting`] extended to carry more
    /// than the one `address` and one `fingerprint` it already does.
    Files(Vec<PathBuf>),
}

/// Why [`resolve`] could not place an entry's artefact.
#[derive(Debug)]
pub enum SourceError {
    /// `descriptor.nature` names a nature
    /// [`crate::descriptor::NATURE_TABLE`] does not carry.
    UnknownNature { nature: String, id: String },
    /// The entry's `path` field is present but names no member — neither a
    /// bare string nor a non-empty array is what ADR-0048 § 2 describes.
    EmptyPath { id: String },
    /// A candidate path — from the nature rule, or from `path` — does not
    /// resolve under the catalogue root.
    Confinement {
        id: String,
        detail: ConfinementError,
    },
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownNature { nature, id } => write!(
                f,
                "entry `{id}` carries nature `{nature}`, which `descriptor::NATURE_TABLE` does not \
                 name — add it there before this entry can be installed"
            ),
            Self::EmptyPath { id } => write!(
                f,
                "entry `{id}` carries a `path` field naming no member — remove the field to fall \
                 back to the nature rule, or name at least one path"
            ),
            Self::Confinement { id, detail } => {
                write!(f, "entry `{id}`'s source {detail}")
            }
        }
    }
}

impl std::error::Error for SourceError {}

/// The exit code owed for a [`SourceError`].
///
/// [`SourceError::UnknownNature`] and [`SourceError::EmptyPath`] are facts
/// about the catalogue entry, fixed only by naming a different one or
/// fixing the catalogue, so both answer [`crate::REQUEST_CANNOT_BE_SATISFIED`];
/// [`SourceError::Confinement`] defers to [`confine::exit_code`] for its own
/// one machine-level case.
pub fn exit_code(err: &SourceError) -> u8 {
    match err {
        SourceError::UnknownNature { .. } | SourceError::EmptyPath { .. } => {
            crate::REQUEST_CANNOT_BE_SATISFIED
        }
        SourceError::Confinement { detail, .. } => confine::exit_code(detail),
    }
}

/// Resolves `descriptor`'s artefact source, relative to `catalogue_root` —
/// the entry's own `path`, when it carries one, ahead of
/// [`crate::descriptor::NATURE_TABLE`]'s rule for its nature (ADR-0048 § 2).
pub fn resolve(catalogue_root: &Path, descriptor: &Descriptor) -> Result<Source, SourceError> {
    if let Some(candidates) = &descriptor.path {
        return resolve_override(catalogue_root, descriptor, candidates);
    }
    resolve_by_nature(catalogue_root, descriptor)
}

/// The `path` branch of [`resolve`]: confines every candidate the entry
/// names, and returns [`Source::File`] for exactly one or [`Source::Files`]
/// for more than one.
fn resolve_override(
    catalogue_root: &Path,
    descriptor: &Descriptor,
    candidates: &[String],
) -> Result<Source, SourceError> {
    if candidates.is_empty() {
        return Err(SourceError::EmptyPath {
            id: descriptor.id.clone(),
        });
    }
    let mut resolved = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        resolved.push(
            confine(catalogue_root, Path::new(candidate)).map_err(|detail| {
                SourceError::Confinement {
                    id: descriptor.id.clone(),
                    detail,
                }
            })?,
        );
    }
    Ok(if resolved.len() == 1 {
        Source::File(resolved.into_iter().next().expect("checked len == 1 above"))
    } else {
        Source::Files(resolved)
    })
}

/// The default branch of [`resolve`]: `<folder>/<local id>`, folder read
/// from [`crate::descriptor::NATURE_TABLE`], disposition read from there too
/// unless the entry declares its own (ADR-0049 § 4) — extension appended for
/// a file whose disposition carries one — ADR-0048 § 1.
fn resolve_by_nature(
    catalogue_root: &Path,
    descriptor: &Descriptor,
) -> Result<Source, SourceError> {
    let (folder, default_disposition) =
        nature_location(&descriptor.nature).ok_or_else(|| SourceError::UnknownNature {
            nature: descriptor.nature.clone(),
            id: descriptor.id.clone(),
        })?;
    // The entry's own declaration wins over the nature's default — the same
    // precedence `path` already gives an entry over the nature's own folder
    // (ADR-0049 § 4).
    let disposition = descriptor.disposition.unwrap_or(default_disposition);

    // The prefix of the id equals the nature on every entry this table was
    // measured against (53 of 53); a colon-free id — which none of them are
    // — falls back to the whole id rather than refusing here, and is caught
    // downstream by confinement or by the artefact turning out absent.
    let local = descriptor
        .id
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or(descriptor.id.as_str());

    let relative = match disposition {
        Disposition::File { extension: "" } => PathBuf::from(folder).join(local),
        Disposition::File { extension } => {
            PathBuf::from(folder).join(format!("{local}.{extension}"))
        }
        Disposition::Directory => PathBuf::from(folder).join(local),
    };

    let confined =
        confine(catalogue_root, &relative).map_err(|detail| SourceError::Confinement {
            id: descriptor.id.clone(),
            detail,
        })?;

    Ok(match disposition {
        Disposition::File { .. } => Source::File(confined),
        Disposition::Directory => Source::Directory(confined),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(id: &str, nature: &str, path: Option<Vec<String>>) -> Descriptor {
        Descriptor {
            id: id.to_string(),
            nature: nature.to_string(),
            catalogue: "acme".to_string(),
            path,
            disposition: None,
        }
    }

    fn descriptor_with_disposition(id: &str, nature: &str, disposition: Disposition) -> Descriptor {
        Descriptor {
            id: id.to_string(),
            nature: nature.to_string(),
            catalogue: "acme".to_string(),
            path: None,
            disposition: Some(disposition),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("rigger-cli-source-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create the scratch root");
        root
    }

    #[test]
    fn a_hook_resolves_to_its_file_under_the_hooks_folder() {
        let root = scratch("hook");
        let entry = descriptor("hook:guard-command", "hook", None);

        let resolved = resolve(&root, &entry).expect("a known nature resolves");

        assert_eq!(resolved, Source::File(root.join("hooks/guard-command.ts")));
    }

    #[test]
    fn a_skill_resolves_to_a_directory_under_the_skills_folder() {
        let root = scratch("skill");
        let entry = descriptor("skill:spec-workflow", "skill", None);

        let resolved = resolve(&root, &entry).expect("a known nature resolves");

        assert_eq!(
            resolved,
            Source::Directory(root.join("skills/spec-workflow"))
        );
    }

    #[test]
    fn an_entry_declaring_a_directory_disposition_overrides_a_file_default_nature() {
        let root = scratch("disposition-directory-override");
        let entry =
            descriptor_with_disposition("hook:guard-command", "hook", Disposition::Directory);

        let resolved = resolve(&root, &entry).expect("a declared disposition resolves");

        assert_eq!(
            resolved,
            Source::Directory(root.join("hooks/guard-command"))
        );
    }

    #[test]
    fn an_entry_declaring_a_file_disposition_overrides_a_directory_default_nature() {
        let root = scratch("disposition-file-override");
        let entry = descriptor_with_disposition(
            "skill:spec-workflow",
            "skill",
            Disposition::File { extension: "" },
        );

        let resolved = resolve(&root, &entry).expect("a declared disposition resolves");

        assert_eq!(resolved, Source::File(root.join("skills/spec-workflow")));
    }

    #[test]
    fn an_unknown_nature_is_refused_by_name() {
        let root = scratch("unknown-nature");
        let entry = descriptor("plugin:acme", "plugin", None);

        let err = resolve(&root, &entry).expect_err("an unlisted nature must be refused");

        assert!(matches!(err, SourceError::UnknownNature { .. }));
        assert_eq!(exit_code(&err), crate::REQUEST_CANNOT_BE_SATISFIED);
    }

    #[test]
    fn a_single_string_path_overrides_the_nature_rule() {
        let root = scratch("override-single");
        let entry = descriptor(
            "context:claude",
            "context",
            Some(vec!["contexts/AGENTS.md".to_string()]),
        );

        let resolved = resolve(&root, &entry).expect("a valid override resolves");

        assert_eq!(resolved, Source::File(root.join("contexts/AGENTS.md")));
    }

    #[test]
    fn an_array_path_of_two_members_resolves_to_files() {
        let root = scratch("override-two");
        let entry = descriptor(
            "guardrail:claude",
            "guardrail",
            Some(vec![
                "guardrails/allow.json".to_string(),
                "guardrails/deny.json".to_string(),
            ]),
        );

        let resolved = resolve(&root, &entry).expect("a two-member override resolves");

        assert_eq!(
            resolved,
            Source::Files(vec![
                root.join("guardrails/allow.json"),
                root.join("guardrails/deny.json"),
            ])
        );
    }

    #[test]
    fn an_empty_path_array_is_refused_rather_than_falling_back_silently() {
        let root = scratch("override-empty");
        let entry = descriptor("hook:guard-command", "hook", Some(Vec::new()));

        let err = resolve(&root, &entry).expect_err("an empty override must be refused");

        assert!(matches!(err, SourceError::EmptyPath { .. }));
    }

    #[test]
    fn a_path_override_leaving_the_catalogue_root_is_confined() {
        let root = scratch("override-escape");
        let entry = descriptor(
            "hook:guard-command",
            "hook",
            Some(vec!["../outside.ts".to_string()]),
        );

        let err = resolve(&root, &entry).expect_err("a `..` override must be refused");

        assert!(matches!(err, SourceError::Confinement { .. }));
    }
}
