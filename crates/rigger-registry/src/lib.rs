//! The registry: what the product recorded of everything it posed, and the only
//! link between a pose and its undoing.
//!
//! The product removes what it posed by **replaying a recorded trace**, never by
//! recognising shapes on disk. So a registry lost, truncated or silently
//! rewritten does not degrade the service — it makes a posed thing permanently
//! unremovable, with no error and nobody noticing. Every refusal in this crate
//! exists against that one damage, and each of them leaves the file exactly as
//! it was.
//!
//! Two modules, and the split is the one the requirements make.
//!
//! [`ledger`] is **what is recorded and how it is read back**: an envelope that
//! fails closed, entries that are tolerated one by one, and refusals whose text
//! comes only from their typed fields.
//!
//! [`transaction`] is **when it may be written**: under an exclusion between
//! runs of the product, after a re-read under that exclusion, and never around
//! the question asked of the user. The order of those is held by types rather
//! than by discipline, because no sequential test can tell a correct order from
//! a wrong one — that is written out where the types are.

pub mod ledger;
pub mod transaction;

pub use ledger::{
    exit_code, Address, AddressNotUtf8, Entry, Identity, Ledger, Posting, RegistryError,
    Unjudgeable, IMPOSSIBLE_REQUEST, POSED_BY, RUNTIME_FAILURE,
};
pub use transaction::{
    replay, transact, Consent, Decision, Fresh, Mutation, Outcome, Proposal, Registry,
};
