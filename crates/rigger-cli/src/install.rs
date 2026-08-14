//! `rigger-cli install <catalog> <id>` — the tracer bullet (bout-en-bout T1):
//! the thinnest path from a real catalogue entry to a file actually posed on
//! disk and recorded in the registry.
//!
//! **What this composition root wires, in order.** [`descriptor::read`] finds
//! the entry in the catalogue; the behaviour that poses it is [`pose`], which
//! resolves and runs the member of `rigger-plan`'s closed set named
//! [`BehaviourName::Link`] on its own — this is the first call in this binary
//! that reaches it, `rigger-plan` and `rigger-registry` having carried no
//! execution path here before this change. What `pose` returns is turned into
//! a [`rigger_registry::Entry`] and recorded through [`transact`], the same
//! order `rigger-registry/tests/tracer_bullet.rs`'s own `install` helper
//! already proved: pose first, and record only what the pose already handed
//! back — never a value built ahead of it.
//!
//! **What is hard-coded here, and why each one is the short way rather than a
//! design decided in passing — every one of these is a T3 question, not a T1
//! answer.**
//!
//! - **Every entry poses through [`BehaviourName::Link`].** The catalogue's
//!   `nature` (`hook`, `lib`, `workflow`, …) names a *kind* of artefact, not
//!   one of the four members of `rigger-plan`'s closed set, and no mapping
//!   from one to the other exists in any crate yet — the nature table
//!   ADR-0037 asks for is not written. `Link` is the one member with a body
//!   that matches what a `[[entries]]` member is: a whole artefact, posed
//!   once. It is not a claim that every entry should resolve to `Link` — only
//!   that this tracer bullet needs one member to prove the wiring with, and
//!   this is the one this crate can serve honestly today.
//! - **The content posed is the descriptor's own fields, not the file a real
//!   entry names.** Resolving an id to the bytes it should carry — the
//!   `hooks/guard-command.ts` a real `hook:guard-command` names — is the
//!   id-to-path convention the catalogue's own contract still leaves open.
//!   Fabricating a convention here, to post a "real" file, would be a second,
//!   competing answer to a question this repository has already recorded as
//!   unsettled. What is posed instead is honest about what this reader
//!   actually read: the entry's `kind`, `id` and `nature`, verbatim.
//! - **The root is the current working directory**, because the command line
//!   `rigger install <catalog> <id>` carries no root argument and no host
//!   model exists to derive one from — the assistant axis this product used
//!   to reason about is retired. Running the binary from an empty directory
//!   and listing it afterwards is exactly how this tracer bullet is meant to
//!   be checked.
//! - **[`confine`] is the T3 answer to what T1 left open here**: the id is
//!   read out of a catalogue this crate did not write, and nothing between
//!   that read and the write to disk used to check it stayed under the root.
//!   `confine` closes that — refusing an absolute id, a `..` component, or a
//!   pre-existing symlink that would carry either the pose or the shared
//!   store entry outside the root — before either destination is touched.
//! - **Consent is hard-coded to always grant.** `rigger-registry::Consent` is
//!   a decision handed in by a caller that reads a terminal; this binary
//!   reads none yet, so there is no prompt to ask and nothing to decide
//!   against. A real answer needs a command surface with an interactive mode,
//!   which is not this tracer bullet's job.
//! - **The registry and the shared store both live under `.rigger/` beneath
//!   the root.** Nothing today reads that location back except this same
//!   binary on its next run against the same root; the location is this
//!   crate's own choice to make, and a fixed, visible one costs nothing to
//!   change later.

use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use rigger_apply::{pose, OnDisk, SystemLiveness, SystemPracticability};
use rigger_plan::{BehaviourName, Fragment, Placement};
use rigger_registry::{
    exit_code as registry_exit_code, transact, Address, Entry, Mutation, Outcome, Posting,
    Registry, POSED_BY,
};

use crate::consent::AlwaysGranted;
use crate::descriptor::{self, DescriptorError};

/// Runs `install <catalog> <id>`, and answers the process's exit code.
pub fn run(catalog: &str, id: &str) -> ExitCode {
    let descriptor = match descriptor::read(std::path::Path::new(catalog), id) {
        Ok(descriptor) => descriptor,
        Err(err) => {
            eprintln!("rigger-cli: {err}");
            return ExitCode::from(descriptor_exit_code(&err));
        }
    };

    let root = match std::env::current_dir() {
        Ok(root) => root,
        Err(err) => {
            eprintln!("rigger-cli: cannot read the working directory: {err}");
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };

    // The id `hook:guard-command` carries a colon, which is a perfectly
    // ordinary filename byte on every system this product is released for,
    // but keeping the address free of it leaves room for a future
    // `nature/id` layout without a rename of what T1 already posed.
    let sanitized = descriptor.id.replace(':', "-");
    let address = PathBuf::from(&sanitized);
    let store_relative = PathBuf::from(".rigger").join("store").join(&sanitized);

    // The id is data this reader read out of the catalogue, not written by
    // this crate — refused here, before either destination is touched, if
    // it would resolve outside `root`. Both destinations are checked: the
    // pose address is exactly the (sanitised) id, and the shared store entry
    // carries the same id as its own final component.
    let posed_at = match confine(&root, &address) {
        Ok(path) => path,
        Err(err) => {
            eprintln!("rigger-cli: cannot install `{}`: {err}", descriptor.id);
            return ExitCode::from(confinement_exit_code(&err));
        }
    };
    let store = match confine(&root, &store_relative) {
        Ok(path) => path,
        Err(err) => {
            eprintln!("rigger-cli: cannot install `{}`: {err}", descriptor.id);
            return ExitCode::from(confinement_exit_code(&err));
        }
    };

    let contents = format!(
        "kind = \"{}\"\nid = \"{}\"\nnature = \"{}\"\n",
        descriptor.kind, descriptor.id, descriptor.nature
    );

    // `pose` refuses to make a directory itself — on purpose: a directory it
    // created would be a change no recorded trace could ever take away. The
    // shared store is this binary's own location, decided here and nowhere
    // else, so making the directory it lives in is this binary's own job.
    if let Some(parent) = store.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!("rigger-cli: cannot create `{}`: {err}", parent.display());
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    }

    let posted = match pose(
        BehaviourName::Link,
        &posed_at,
        &Fragment::Artefact {
            store,
            contents,
            placement: Placement::Link,
        },
        &OnDisk,
        &SystemPracticability,
    ) {
        Ok(posted) => posted,
        Err(err) => {
            eprintln!("rigger-cli: cannot pose `{}`: {err}", descriptor.id);
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };

    let root_address = match Address::new(&root) {
        Ok(root_address) => root_address,
        Err(err) => {
            eprintln!("rigger-cli: {err}");
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };
    let entry_address = match Address::new(&address) {
        Ok(entry_address) => entry_address,
        Err(err) => {
            eprintln!("rigger-cli: {err}");
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };

    let entry = match Entry::posted(Posting {
        id: descriptor.id.clone(),
        provenance: descriptor.catalogue.clone(),
        behaviour: BehaviourName::Link.as_str().to_string(),
        posed_by: POSED_BY.to_string(),
        root: root_address,
        address: entry_address,
        fingerprint: posted.fingerprint.to_string(),
        trace: posted.trace,
    }) {
        Ok(entry) => entry,
        Err(err) => {
            eprintln!("rigger-cli: cannot record `{}`: {err}", descriptor.id);
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };

    let registry = Registry::at(root.join(".rigger").join("registry"));
    match transact(
        &registry,
        &[Mutation::Upsert(entry.clone())],
        &AlwaysGranted,
        &SystemLiveness,
    ) {
        Ok(Outcome::Committed { .. }) => {
            println!("installed `{}` at {}", descriptor.id, entry.at().display());
            ExitCode::from(crate::SUCCESS)
        }
        Ok(Outcome::Refused { .. }) => {
            // Unreachable while consent is hard-coded to always grant — kept
            // as a message rather than a panic, because a refusal here is a
            // fact about the registry, not a bug this binary should crash
            // over.
            eprintln!(
                "rigger-cli: the registry refused to record `{}`",
                descriptor.id
            );
            ExitCode::from(crate::RUNTIME_FAILURE)
        }
        Err(err) => {
            eprintln!("rigger-cli: cannot record `{}`: {err}", descriptor.id);
            ExitCode::from(registry_exit_code(&err))
        }
    }
}

/// The exit code owed for a descriptor that could not be read.
///
/// Every member answers [`crate::REQUEST_CANNOT_BE_SATISFIED`] — a `<catalog>`
/// this reader cannot turn into a working descriptor is exactly the shape of
/// request this code names, whether the reason is an id the catalogue does
/// not carry, or the catalogue itself being unreadable, not UTF-8, not TOML,
/// at a `format` this reader does not know, or missing a field an entry must
/// carry. None of these is a fact about this machine that a retry would clear
/// — every one of them is fixed by pointing the command at a different
/// catalogue or a different id, which is what that code is for.
fn descriptor_exit_code(err: &DescriptorError) -> u8 {
    match err {
        DescriptorError::NotFound { .. }
        | DescriptorError::Read { .. }
        | DescriptorError::NotUtf8 { .. }
        | DescriptorError::Malformed { .. }
        | DescriptorError::UnknownFormat { .. }
        | DescriptorError::MissingField { .. } => crate::REQUEST_CANNOT_BE_SATISFIED,
    }
}

/// Refuses to let `relative` — data this reader read out of the catalogue,
/// not written by this crate — resolve to anywhere outside `root`: an
/// absolute path, a `..` component, or (the one those two checks cannot see)
/// an existing symlink among `root`'s own children that this filesystem
/// would follow outside it. Returns the joined path on success — still not
/// guaranteed to exist, only guaranteed to resolve under `root` as far as
/// this filesystem can be asked today.
///
/// **Why this lives in `rigger-cli`, not `rigger-apply`.** `pose` takes an
/// address as an opaque value and poses exactly there; nothing in it carries
/// a notion of "root" an address must stay under — that notion belongs to
/// this binary, the composition root that turns a catalogue's own `id` into
/// a path on the caller's disk.
fn confine(root: &Path, relative: &Path) -> Result<PathBuf, ConfinementError> {
    if relative.is_absolute() {
        return Err(ConfinementError::Absolute {
            relative: relative.to_path_buf(),
        });
    }
    if relative
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ConfinementError::Traversal {
            relative: relative.to_path_buf(),
        });
    }

    let canonical_root = root.canonicalize().map_err(|detail| ConfinementError::Io {
        path: root.to_path_buf(),
        detail,
    })?;

    // `joined` may not exist yet — only its deepest existing ancestor can be
    // canonicalised, and that ancestor is exactly where a symlink escaping
    // `root` would have to sit, since nothing past it exists on this
    // filesystem for the resolution to run through.
    let joined = root.join(relative);
    let mut probe: &Path = &joined;
    while !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    let canonical_probe = probe
        .canonicalize()
        .map_err(|detail| ConfinementError::Io {
            path: probe.to_path_buf(),
            detail,
        })?;
    if !canonical_probe.starts_with(&canonical_root) {
        return Err(ConfinementError::Symlink {
            relative: relative.to_path_buf(),
        });
    }

    Ok(joined)
}

/// Why [`confine`] refused an id before anything was posed for it. Every
/// member leaves the filesystem exactly as `install` found it — `confine`
/// runs, and refuses, before either destination it guards is touched.
#[derive(Debug)]
enum ConfinementError {
    /// The id, once sanitised, is an absolute path — joining it to the root
    /// would replace the root outright rather than resolve under it.
    Absolute { relative: PathBuf },
    /// The id carries a `..` component, which would resolve above the root
    /// rather than under it.
    Traversal { relative: PathBuf },
    /// Once existing symlinks on this filesystem are followed, the id
    /// resolves to a path outside the root.
    Symlink { relative: PathBuf },
    /// The root, or the deepest of the id's own leading directories that
    /// exists, could not be resolved at all.
    Io { path: PathBuf, detail: io::Error },
}

impl fmt::Display for ConfinementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absolute { relative } => write!(
                f,
                "its id resolves to the absolute path `{}` — an id must resolve to a location \
                 under the root, not replace it",
                relative.display()
            ),
            Self::Traversal { relative } => write!(
                f,
                "its id resolves to `{}`, which leaves the root through a `..` component",
                relative.display()
            ),
            Self::Symlink { relative } => write!(
                f,
                "its id resolves to `{}`, which an existing symlink on this filesystem leads \
                 outside the root",
                relative.display()
            ),
            Self::Io { path, detail } => write!(
                f,
                "cannot resolve `{}` to check it stays under the root — {detail}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for ConfinementError {}

/// The exit code owed for a [`ConfinementError`].
///
/// [`ConfinementError::Io`] is a fact about this machine — the root or one of
/// its own directories could not be resolved — so it answers
/// [`crate::RUNTIME_FAILURE`]; the other three are facts about the id itself,
/// fixed only by naming a different one, so they answer
/// [`crate::REQUEST_CANNOT_BE_SATISFIED`].
fn confinement_exit_code(err: &ConfinementError) -> u8 {
    match err {
        ConfinementError::Absolute { .. }
        | ConfinementError::Traversal { .. }
        | ConfinementError::Symlink { .. } => crate::REQUEST_CANNOT_BE_SATISFIED,
        ConfinementError::Io { .. } => crate::RUNTIME_FAILURE,
    }
}
