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
//! - **The content posed is the artefact [`source::resolve`] finds, read
//!   whole off disk — ADR-0048.** The nature table it carries, plus an
//!   entry's own `path` when it has one, resolves the id-to-path question
//!   this module used to leave open by posing the descriptor's own fields
//!   instead. What that resolution cannot yet turn into bytes — a whole
//!   directory, or more than one file under one id — is refused by name
//!   rather than posed as something it is not; see [`Source::Directory`]
//!   and [`Source::Files`] for what is missing and why.
//! - **The root is the current working directory**, because the command line
//!   `rigger install <catalog> <id>` carries no root argument and no host
//!   model exists to derive one from — the assistant axis this product used
//!   to reason about is retired. Running the binary from an empty directory
//!   and listing it afterwards is exactly how this tracer bullet is meant to
//!   be checked.
//! - **[`crate::confine`] is the T3 answer to what T1 left open here**: the
//!   id is read out of a catalogue this crate did not write, and nothing
//!   between that read and the write to disk used to check it stayed under
//!   the root. `confine` closes that on the write side — refusing an
//!   absolute id, a `..` component, or a pre-existing symlink that would
//!   carry either the pose or the shared store entry outside the root —
//!   before either destination is touched. [`source::resolve`] runs the
//!   same confinement on the read side, against the catalogue's own root,
//!   before an artefact is ever opened.
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

use std::io;
use std::path::PathBuf;
use std::process::ExitCode;

use rigger_apply::{pose, OnDisk, PoseError, StepError, SystemLiveness, SystemPracticability};
use rigger_plan::{BehaviourName, Fragment, Placement};
use rigger_registry::{
    exit_code as registry_exit_code, transact, Address, Entry, Identity, Mutation, Outcome,
    Posting, Registry, POSED_BY,
};

use crate::confine::confine;
use crate::consent::AlwaysGranted;
use crate::descriptor::{self, DescriptorError};
use crate::source::{self, Source};

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
            eprintln!(
                "rigger-cli: cannot install `{}`: its id {err}",
                descriptor.id
            );
            return ExitCode::from(crate::confine::exit_code(&err));
        }
    };
    let store = match confine(&root, &store_relative) {
        Ok(path) => path,
        Err(err) => {
            eprintln!(
                "rigger-cli: cannot install `{}`: its id {err}",
                descriptor.id
            );
            return ExitCode::from(crate::confine::exit_code(&err));
        }
    };

    // The catalogue's own root — `path.parent()` of the catalogue read
    // above — is what an entry's source resolves relative to (ADR-0048 § 1),
    // never the install root just confined above: an empty parent (a bare
    // `catalog.toml` with no leading directory) means "here", not "nowhere".
    let catalogue_root = std::path::Path::new(catalog)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));

    let resolved = match source::resolve(catalogue_root, &descriptor) {
        Ok(resolved) => resolved,
        Err(err) => {
            eprintln!("rigger-cli: cannot install `{}`: {err}", descriptor.id);
            return ExitCode::from(source::exit_code(&err));
        }
    };
    let source_file = match resolved {
        Source::File(path) => path,
        Source::Directory(path) => {
            eprintln!(
                "rigger-cli: cannot install `{}`: `{}` is a directory, and rigger_apply::pose only \
                 carries a single-file `Fragment::Artefact` today — posing a whole directory needs \
                 that engine extended before this entry can be installed",
                descriptor.id,
                path.display()
            );
            return ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED);
        }
        Source::Files(paths) => {
            let named: Vec<String> = paths
                .iter()
                .map(|path| path.display().to_string())
                .collect();
            eprintln!(
                "rigger-cli: cannot install `{}`: its `path` names {} files ({}), and \
                 rigger_registry::Posting carries one address and one fingerprint per record today \
                 — posing more than one file under this id needs that record extended before this \
                 entry can be installed",
                descriptor.id,
                named.len(),
                named.join(", ")
            );
            return ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED);
        }
    };

    let metadata = match std::fs::metadata(&source_file) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            eprintln!(
                "rigger-cli: cannot install `{}`: no artefact at `{}`",
                descriptor.id,
                source_file.display()
            );
            return ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED);
        }
        Err(err) => {
            eprintln!("rigger-cli: cannot read `{}`: {err}", source_file.display());
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };
    if metadata.is_dir() {
        eprintln!(
            "rigger-cli: cannot install `{}`: `{}` is a directory, and rigger_apply::pose only \
             carries a single-file `Fragment::Artefact` today — posing a whole directory needs that \
             engine extended before this entry can be installed",
            descriptor.id,
            source_file.display()
        );
        return ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED);
    }

    let contents = match std::fs::read_to_string(&source_file) {
        Ok(contents) => contents,
        Err(err) => {
            eprintln!("rigger-cli: cannot read `{}`: {err}", source_file.display());
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };

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
            // `pose` just refused an address something already occupies —
            // and that "something" may be the very entry this same product
            // posed on a previous run of this same command. The registry is
            // the one place that can settle it: if it names this identity at
            // this address, this is not damage to a file the product never
            // touched, it is a second install of what is already installed,
            // and the difference changes both the message and the exit code
            // (a request that cannot be satisfied, not a runtime failure —
            // nothing broke, the machine is exactly as the first install
            // left it). If the registry does not carry it — the ordinary
            // case this refusal exists for — `err`'s own message already
            // says the honest thing and is printed unchanged.
            if let Some(occupied) = occupied_address(&err) {
                let identity = Identity {
                    provenance: descriptor.catalogue.clone(),
                    id: descriptor.id.clone(),
                };
                if let Some(entry) = already_installed(&root, &identity, occupied) {
                    eprintln!(
                        "rigger-cli: cannot install `{}`: {} already carries what this product \
                         posed for it, from `{}` — remove it before installing again",
                        descriptor.id,
                        entry.at().display(),
                        entry.provenance(),
                    );
                    return ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED);
                }
            }
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

/// The address `pose` refused to write over because something is already
/// there, when that is the reason `err` carries — `None` for every other
/// refusal, none of which the registry has anything to say about.
///
/// Only [`PoseError::RolledBack`] is matched, deliberately not
/// [`PoseError::NotRestored`]: the latter is a step failing **and** its own
/// rollback failing, which leaves the machine in a state this diagnosis does
/// not apply to and must not paper over.
fn occupied_address(err: &PoseError) -> Option<&std::path::Path> {
    match err {
        PoseError::RolledBack {
            failure: StepError::Occupied { address },
            ..
        } => Some(address),
        _ => None,
    }
}

/// The entry the registry itself already records at `identity`, when it is
/// the entry occupying `address` — proof, read out of the registry rather
/// than assumed, that this product posed what is there.
///
/// A registry that cannot be read answers `None`, the same as one that
/// simply does not carry the identity: either way there is nothing here to
/// stand behind a claim that this product posed it, so the caller falls back
/// to the refusal `pose` itself already gave.
fn already_installed(
    root: &std::path::Path,
    identity: &Identity,
    address: &std::path::Path,
) -> Option<Entry> {
    let registry = Registry::at(root.join(".rigger").join("registry"));
    let ledger = registry.read().ok()?;
    ledger
        .entries()
        .iter()
        .find(|entry| entry.identity() == identity && entry.at() == address)
        .cloned()
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
        | DescriptorError::MissingField { .. }
        | DescriptorError::InvalidPath { .. } => crate::REQUEST_CANNOT_BE_SATISFIED,
    }
}
