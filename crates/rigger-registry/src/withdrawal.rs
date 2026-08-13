//! MD-38's closed set of issues a withdrawal can conclude with, and the exit
//! code each of them derives — declared once, so a caller-facing channel
//! projects this set instead of choosing its own code for each event.
//!
//! MD-38 names the gap directly: the product closes the set of *behaviours*
//! a run may carry out, locked at the compiler, but nothing closes the set
//! of *issues* a channel reports once a run concludes — so today every
//! caller is free to invent which code answers which event, and a refusal
//! to consent has no code distinct from a real failure. [`WithdrawalIssue`]
//! is that closed set for one operation, a withdrawal — the removal of
//! something the product posed.

use crate::transaction::Outcome;

/// The closed set of issues a withdrawal — the removal of something the
/// product posed — can be reported with.
///
/// **Three members, declared together.** A withdrawal either takes
/// everything it named off the machine ([`Self::Complete`]), takes some of
/// it off and reports the rest rather than silently standing in for the
/// whole ([`Self::Partial`]), or the caller who was asked said no
/// ([`Self::ConsentRefused`], never counted among failures). Only the first
/// and the third have a producer in this product today; [`Self::Partial`]'s
/// own doc comment says why it is still declared here rather than added the
/// day it gets one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WithdrawalIssue {
    /// Every address the withdrawal named was undone, and the registry no
    /// longer records the entry.
    Complete,

    /// Some, not all, of the addresses a withdrawal named were undone.
    ///
    /// **Measured, not assumed, to have no producer in this product.**
    /// [`rigger_apply::carry`] is the one function that carries a
    /// withdrawal's steps onto disk, and its own doc comment states the
    /// contract it is built to: it seizes every address before touching any
    /// of them and gives all of them back on the first failure. A single
    /// withdrawal is therefore all-or-nothing by construction — no code
    /// path stops partway through one and reports the remainder. Reaching a
    /// genuine partial removal would need an orchestration layer over
    /// *several* withdrawals, deciding per entry whether to keep going
    /// after one of them fails, and nothing in this workspace builds one:
    /// [`Self::Complete`] and [`Self::ConsentRefused`] are both constructed
    /// in [`Self::of_withdrawal`], and no call site anywhere in this crate
    /// constructs [`Self::Partial`].
    ///
    /// The member stays regardless. Leaving it out would make this set
    /// incomplete the day that orchestration layer is built — the exact
    /// defect this type exists to close, with a caller once again the one
    /// deciding, alone, what code a partial withdrawal gets. What is
    /// missing is a producer to test against, not the name.
    Partial,

    /// The caller was asked whether to write the withdrawal, **and answered**
    /// — no. The registry was not touched.
    ///
    /// **This variant means a response was received, and only that.** It is
    /// not a failure: the product asked, the caller said no, and every step
    /// of that exchange went exactly as it should — nothing broke. That is
    /// why its exit code equals [`Self::Complete`]'s rather than a real
    /// failure's; see [`Self::exit_code`] for the reasoning written where
    /// the codes are chosen.
    ///
    /// **Reserved, not covered: being unable to ask at all.** A future
    /// non-interactive mode — one that cannot prompt a caller and so
    /// produces neither a grant nor a refusal — is a third thing, distinct
    /// from both an answer and a tool failure, and it will need its own
    /// member. Do not fold it into this one: `ConsentRefused` is built from
    /// [`crate::transaction::Decision::Refused`], an answer that actually
    /// came back, and reusing it for "the question was never put" would
    /// make a caller read "the user declined" out of a run where nobody was
    /// asked.
    ConsentRefused,
}

impl WithdrawalIssue {
    /// Reads the issue directly off what a withdrawal's transaction did,
    /// rather than a caller re-deciding it at each call site — the
    /// duplication MD-38 names as the actual defect behind a refused
    /// consent having no exit code of its own.
    ///
    /// Callers propose a withdrawal as a slice of
    /// [`crate::transaction::Mutation::Remove`] and pass the [`Outcome`]
    /// [`crate::transact`] returns for it. [`Outcome`] itself carries only
    /// two states, so this can only ever answer [`Self::Complete`] or
    /// [`Self::ConsentRefused`] — never [`Self::Partial`], for the reason
    /// its own doc comment gives.
    pub fn of_withdrawal(outcome: &Outcome) -> Self {
        match outcome {
            Outcome::Committed { .. } => Self::Complete,
            Outcome::Refused { .. } => Self::ConsentRefused,
        }
    }

    /// The code a command exits with once a withdrawal has concluded with
    /// this issue.
    ///
    /// **Exhaustive on purpose, and the one place these codes are chosen.**
    /// A member added to this set later does not build until its code is
    /// decided here — the same discipline [`crate::exit_code`] states for
    /// A1's closed set of registry-read refusals. The two functions are
    /// kept apart rather than merged into one match, and neither reuses the
    /// other's codes: A1 and MD-38 close two different sets — a registry
    /// this build cannot read is not a value of this enum, and a withdrawal
    /// that has concluded is not a value of
    /// [`crate::ledger::RegistryError`] — so merging their codes would let
    /// one accounting answer a question that belongs to the other.
    ///
    /// **[`Self::Complete`] and [`Self::ConsentRefused`] share `0`, and that
    /// is not a collision to be "fixed" later.** `0` answers one question —
    /// did the tool do anything other than exactly what it was asked? — and
    /// both members answer no. A withdrawal that went all the way and a
    /// caller who was asked and declined are, from the machine's own point
    /// of view, the same event: nothing broke, nothing was left in a state
    /// nobody chose. MD-38 requires that a refusal to consent never be
    /// counted among failures; it does not require that it be
    /// distinguishable from success either, and this function derives
    /// exactly that requirement and no more. [`Self::Partial`] is the one
    /// member something *did* go wrong for — some of what a withdrawal
    /// named was left behind — so it alone keeps a code of its own.
    pub fn exit_code(self) -> u8 {
        match self {
            Self::Complete => 0,
            Self::ConsentRefused => 0,
            Self::Partial => 4,
        }
    }
}
