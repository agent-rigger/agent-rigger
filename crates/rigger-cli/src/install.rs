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
//!   instead. A whole directory, or the several files a `path` array names,
//!   is posed as one tree — ADR-0049 — through the same call to `pose` a
//!   single artefact goes through, [`Fragment::Tree`] taking the place of
//!   [`Fragment::Artefact`].
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
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rigger_apply::{
    pose, read_tree, OnDisk, PoseError, StepError, SystemLiveness, SystemPracticability,
};
use rigger_plan::{BehaviourName, Fragment, Placement, Tree, TreeEntry};
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
    // Captured here, before `store` moves into whichever `Fragment` is built
    // below, so the directory it lives in can still be made afterwards —
    // after the source has been read, never before.
    let store_directory = store.parent().map(Path::to_path_buf);

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

    // What each arm reads off disk differs — one artefact, a whole tree, or
    // the small tree several named files form — but every arm ends in a
    // `Fragment` `pose` carries out the same way, through the one call below
    // (ADR-0049): `Fragment::Tree` is planted by the same `Behaviour::Link`
    // that materialises `Fragment::Artefact`, so nothing past this match
    // needs to know which shape this entry named. Reading happens before
    // anything is written: an artefact absent from the source leaves nothing
    // behind, not even `.rigger` itself.
    let fragment = match resolved {
        Source::File(path) => {
            let contents = match read_artefact_file(&path, &descriptor.id) {
                Ok(contents) => contents,
                Err(code) => return code,
            };
            Fragment::Artefact {
                store,
                contents,
                placement: Placement::Link,
            }
        }
        Source::Directory(path) => {
            let entries = match read_tree(&path) {
                Ok(entries) => entries,
                Err(err) => {
                    eprintln!("rigger-cli: cannot install `{}`: {err}", descriptor.id);
                    return ExitCode::from(tree_read_exit_code(&err));
                }
            };
            Fragment::Tree {
                store,
                entries,
                placement: Placement::Link,
            }
        }
        Source::Files(paths) => {
            let entries = match read_named_files(&paths, &descriptor.id) {
                Ok(entries) => entries,
                Err(code) => return code,
            };
            Fragment::Tree {
                store,
                entries,
                placement: Placement::Link,
            }
        }
    };

    // `pose` refuses to make a directory itself — on purpose: a directory it
    // created would be a change no recorded trace could ever take away. The
    // shared store is this binary's own location, decided here and nowhere
    // else, so making the directory it lives in is this binary's own job.
    // The path was captured before `store` moved into `fragment` above.
    if let Some(parent) = store_directory {
        if let Err(err) = std::fs::create_dir_all(&parent) {
            eprintln!("rigger-cli: cannot create `{}`: {err}", parent.display());
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    }

    let posted = match pose(
        BehaviourName::Link,
        &posed_at,
        &fragment,
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
        | DescriptorError::InvalidPath { .. }
        | DescriptorError::InvalidDisposition { .. } => crate::REQUEST_CANNOT_BE_SATISFIED,
    }
}

/// Reads the bytes of a single artefact file — the [`Source::File`] case of
/// [`source::resolve`] — or the exit code owed for why it could not be.
///
/// **The directory check stays even though `install` now knows how to pose a
/// tree.** An entry whose disposition names a *file* — from
/// [`crate::descriptor::NATURE_TABLE`], an entry's own override, or a
/// single-member `path` — still promises exactly one artefact; a directory
/// found where that promise names a file is a mismatch between what the
/// catalogue declared and what is on disk, and the product does not
/// silently reinterpret one shape as the other. It names the mismatch and
/// refuses.
fn read_artefact_file(path: &Path, id: &str) -> Result<String, ExitCode> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            eprintln!(
                "rigger-cli: cannot install `{id}`: no artefact at `{}`",
                path.display()
            );
            return Err(ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED));
        }
        Err(err) => {
            eprintln!("rigger-cli: cannot read `{}`: {err}", path.display());
            return Err(ExitCode::from(crate::RUNTIME_FAILURE));
        }
    };
    if metadata.is_dir() {
        eprintln!(
            "rigger-cli: cannot install `{id}`: `{}` is a directory, and this entry's disposition \
             names a file — declare `disposition = \"directory\"` on the entry if a directory is \
             what should be posed here",
            path.display()
        );
        return Err(ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED));
    }
    std::fs::read_to_string(path).map_err(|err| {
        eprintln!("rigger-cli: cannot read `{}`: {err}", path.display());
        ExitCode::from(crate::RUNTIME_FAILURE)
    })
}

/// The exit code owed for a [`StepError`] [`read_tree`] raised while reading
/// a *source* directory — never one raised while writing, since nothing has
/// touched the disk yet by the time this runs.
///
/// [`StepError::SymbolicLink`] and [`StepError::NotUtf8`] are facts about the
/// catalogue's own tree, fixed only by changing what it carries, so both
/// answer [`crate::REQUEST_CANNOT_BE_SATISFIED`] — the same code
/// [`source::exit_code`] answers for a fact about the catalogue entry itself.
/// A missing directory answers the same, matching [`read_artefact_file`]'s
/// own treatment of a missing file. Every other [`StepError`] this function
/// might see is a fact about this machine, since nothing [`read_tree`] can
/// raise names an address it wrote to — it writes nothing — so the rest
/// answer [`crate::RUNTIME_FAILURE`].
fn tree_read_exit_code(err: &StepError) -> u8 {
    match err {
        StepError::SymbolicLink { .. } | StepError::NotUtf8 { .. } => {
            crate::REQUEST_CANNOT_BE_SATISFIED
        }
        StepError::Io { detail, .. } if detail.kind() == io::ErrorKind::NotFound => {
            crate::REQUEST_CANNOT_BE_SATISFIED
        }
        _ => crate::RUNTIME_FAILURE,
    }
}

/// Reads the files a multi-member `path` override names — the
/// [`Source::Files`] case of [`source::resolve`] — as the small tree they
/// form, each entered under its own file name.
///
/// **This is what turns a `path` array into a single address and a single
/// fingerprint, rather than a shape that would need `rigger_registry::Posting`
/// extended to carry more than the one `address` and one `fingerprint` it
/// already does.** ADR-0049 § 4: once the unit of pose can be a whole
/// directory, several named files under one id are exactly a small one,
/// planted the same way [`Source::Directory`] is.
fn read_named_files(paths: &[PathBuf], id: &str) -> Result<Tree, ExitCode> {
    let mut entries = Vec::with_capacity(paths.len());
    for path in paths {
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                eprintln!(
                    "rigger-cli: cannot install `{id}`: no artefact at `{}`",
                    path.display()
                );
                return Err(ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED));
            }
            Err(err) => {
                eprintln!("rigger-cli: cannot read `{}`: {err}", path.display());
                return Err(ExitCode::from(crate::RUNTIME_FAILURE));
            }
        };
        let name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name.to_string(),
            None => {
                eprintln!(
                    "rigger-cli: cannot install `{id}`: `{}` names no UTF-8 file name to plant it \
                     under",
                    path.display()
                );
                return Err(ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED));
            }
        };
        entries.push(TreeEntry { name, contents });
    }
    let tree = Tree::of(entries);
    if let Some(duplicate) = first_duplicate_name(tree.entries()) {
        eprintln!(
            "rigger-cli: cannot install `{id}`: two of its `path` members are both named \
             `{duplicate}` once planted — a tree needs one entry per name"
        );
        return Err(ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED));
    }
    Ok(tree)
}

/// The first name two adjacent entries of a sorted tree share, or `None`
/// when every one of them is distinct.
///
/// [`Tree::of`] sorts by name and does not itself refuse a repeat — reading a
/// whole directory off a real filesystem can never produce two files under
/// the same relative name, so [`read_tree`] carries no such check either.
/// [`read_named_files`] builds a tree by hand, out of file names it did not
/// itself confirm are distinct, so it is the one caller here that needs to
/// ask.
fn first_duplicate_name(entries: &[TreeEntry]) -> Option<&str> {
    entries
        .windows(2)
        .find(|pair| pair[0].name == pair[1].name)
        .map(|pair| pair[0].name.as_str())
}
