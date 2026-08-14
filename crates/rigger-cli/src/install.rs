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

use std::path::PathBuf;
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
    let store = root.join(".rigger").join("store").join(&sanitized);
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
        &root.join(&address),
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
/// Only [`DescriptorError::NotFound`] names a request that cannot be
/// satisfied — asking for an id the catalogue does not carry, the same shape
/// as `rigger-cli`'s own unknown-command refusal. Every other member reports
/// that the catalogue itself could not be read or trusted, which retyping the
/// request does not fix.
fn descriptor_exit_code(err: &DescriptorError) -> u8 {
    match err {
        DescriptorError::NotFound { .. } => crate::REQUEST_CANNOT_BE_SATISFIED,
        DescriptorError::Read { .. }
        | DescriptorError::NotUtf8 { .. }
        | DescriptorError::Malformed { .. }
        | DescriptorError::UnknownFormat { .. }
        | DescriptorError::MissingField { .. } => crate::RUNTIME_FAILURE,
    }
}
