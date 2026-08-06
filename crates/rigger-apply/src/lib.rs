//! Writing an owned document: what `rigger-grammar` cannot carry because it is
//! pure, and what the file plan puts here.
//!
//! **What is not here yet.** The inter-process lock
//! (`crates/rigger-apply/src/lock.rs`) belongs to this crate and arrives with
//! family A. Its absence does not make this module useless, and that is the
//! substance of C8: the lock excludes other runs **of the product**, it can do
//! nothing against the host, which rewrites its own settings files — measured on
//! 2026-08-06, and routine. The fingerprint guard is the only defence against
//! the one concurrent writer the product can neither exclude nor foresee.

pub mod txn;

pub use txn::{
    capture, merge_into_file, stage, ApplyError, Capture, Fingerprint, Staged, TxnError,
};
