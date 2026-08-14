//! `rigger-cli remove <id>` — T2 of the bout-en-bout change: the plumbing
//! that connects this binary to `rigger_apply::withdraw`, the removal half
//! of the engine T1 already wired a pose to.
//!
//! **What this reuses, and where the sequence was proved first.**
//! `crates/rigger-registry/tests/tracer_bullet.rs`'s own `uninstall` helper
//! already carries out this order — read the registry, resolve the
//! behaviour the entry names, replay its trace, withdraw, then record the
//! removal — and its module doc comment says the order is written there,
//! once, "so that the day it moves into the command surface there is one
//! place to read it from." This is that day, for the removal half; T1
//! already moved the pose half into [`crate::install`].
//!
//! **Why this does not call `transact` for the removal itself, and takes
//! `Registry::lock`/`Registry::reread`/`Fresh::commit` apart instead.**
//! `transact` asks its question, then locks, re-reads and writes in one
//! call, with no seam for anything to run between the re-read and the
//! write. `withdraw` — the filesystem half of a removal — has to run
//! against the ledger read **under the lock**, not the one read before it:
//! a referent count taken before the lock could be stale by the time the
//! files are actually touched, which is exactly the lost-update window this
//! crate's own lock exists to close for a write. So the lock is taken here
//! directly, the same composition `Registry::reread`'s own doc comment
//! demonstrates, with `withdraw` carried out in the window between the
//! re-read and the commit — the lock surrounding the write, per its own
//! module doc comment, and nothing wider than that. Consent is still asked
//! first, unlocked, matching `transact`'s own documented order — this file
//! just asks it by hand rather than through that function, for the same
//! reason it does not call it for the commit.
//!
//! **What is hard-coded here, and why — the same kind of T3 question T1's
//! own module doc comment already named for install, not restated in full
//! here.** Consent is [`crate::consent::AlwaysGranted`]; the root is the
//! current working directory; an id ambiguous across two catalogues is
//! matched by [`rigger_registry::Entry::id`] alone, exactly as
//! `uninstall`'s own helper does — resolving that ambiguity is not this
//! tracer bullet's job either.

use std::process::ExitCode;

use rigger_apply::{withdraw, OnDisk, SystemLiveness};
use rigger_plan::{replay, Referents};
use rigger_registry::{
    exit_code as registry_exit_code, resolve_behaviour, Consent, Decision, Mutation, Outcome,
    Proposal, Registry, RegistryError, WithdrawalIssue,
};

use crate::consent::AlwaysGranted;

/// Runs `remove <id>`, and answers the process's exit code.
pub fn run(id: &str) -> ExitCode {
    let root = match std::env::current_dir() {
        Ok(root) => root,
        Err(err) => {
            eprintln!("rigger-cli: cannot read the working directory: {err}");
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };
    let registry = Registry::at(root.join(".rigger").join("registry"));

    // Read once, unlocked, before anything is asked or taken — the same
    // order `transact`'s own doc comment states: "the question is asked
    // **before** the lock is taken". A `remove` naming an id the registry
    // does not carry is refused right here, without ever touching the lock
    // file.
    let initial = match registry.read() {
        Ok(ledger) => ledger,
        Err(err) => {
            eprintln!("rigger-cli: cannot read the registry: {err}");
            return ExitCode::from(registry_exit_code(&err));
        }
    };
    let identity = match initial.entries().iter().find(|entry| entry.id() == id) {
        Some(entry) => entry.identity().clone(),
        None => {
            eprintln!("rigger-cli: no entry named `{id}` in the registry");
            return ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED);
        }
    };

    let mutations = [Mutation::Remove {
        identity: identity.clone(),
    }];
    let decision = AlwaysGranted.decide(&Proposal {
        registry: registry.path(),
        ledger: &initial,
        mutations: &mutations,
    });
    if decision == Decision::Refused {
        // Unreachable while consent is hard-coded to always grant — see
        // `crate::install` for why this is a message rather than a panic: a
        // refusal here is a fact about the registry, not a bug this binary
        // should crash over.
        let issue = WithdrawalIssue::of_withdrawal(&Outcome::Refused { ledger: initial });
        eprintln!("rigger-cli: the registry refused the removal of `{id}`");
        return ExitCode::from(issue.exit_code());
    }

    let held = match registry.lock().acquire(&SystemLiveness) {
        Ok(held) => held,
        Err(err) => {
            let err = RegistryError::from(err);
            eprintln!("rigger-cli: cannot lock the registry: {err}");
            return ExitCode::from(registry_exit_code(&err));
        }
    };
    let fresh = match registry.reread(&held) {
        Ok(fresh) => fresh,
        Err(err) => {
            eprintln!("rigger-cli: cannot re-read the registry: {err}");
            return ExitCode::from(registry_exit_code(&err));
        }
    };

    // Looked up again, under the lock, rather than reusing the entry found
    // in `initial`: what is withdrawn must be what the registry names right
    // now, not what it named before the lock was taken.
    let entry = match fresh
        .ledger()
        .entries()
        .iter()
        .find(|entry| entry.identity() == &identity)
    {
        Some(entry) => entry,
        None => {
            eprintln!("rigger-cli: no entry named `{id}` in the registry");
            return ExitCode::from(crate::REQUEST_CANNOT_BE_SATISFIED);
        }
    };

    let name = match resolve_behaviour(entry) {
        Ok(name) => name,
        Err(err) => {
            eprintln!("rigger-cli: cannot remove `{id}`: {err}");
            return ExitCode::from(registry_exit_code(&err));
        }
    };
    let trace = match replay(name, entry.trace()) {
        Ok(trace) => trace,
        Err(err) => {
            eprintln!("rigger-cli: cannot read the recorded trace for `{id}`: {err}");
            return ExitCode::from(crate::RUNTIME_FAILURE);
        }
    };
    let referents = match trace.store() {
        Some(store) => fresh.ledger().referents(store, entry.identity()),
        None => Referents::Last,
    };
    let address = entry.at();

    if let Err(err) = withdraw(name, &address, &trace, referents, &OnDisk) {
        eprintln!("rigger-cli: cannot withdraw `{id}`: {err}");
        return ExitCode::from(crate::RUNTIME_FAILURE);
    }

    match fresh.commit(&[Mutation::Remove { identity }]) {
        Ok(ledger) => {
            let issue = WithdrawalIssue::of_withdrawal(&Outcome::Committed { ledger });
            println!("removed `{id}` from {}", address.display());
            ExitCode::from(issue.exit_code())
        }
        Err(err) => {
            eprintln!("rigger-cli: cannot record the removal of `{id}`: {err}");
            ExitCode::from(registry_exit_code(&err))
        }
    }
}
