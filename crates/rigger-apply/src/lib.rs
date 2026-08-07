//! Writing an owned document: what `rigger-grammar` cannot carry because it is
//! pure, and what the file plan puts here.
//!
//! **Two writers, two defences, and neither replaces the other.** [`lock`]
//! excludes other runs **of the product** from the window in which the registry
//! is read, decided and written. It can do nothing against the host, which
//! rewrites its own settings files — measured on 2026-08-06, and routine. That
//! is what [`txn`] is for: the write of an owned document is conditioned on what
//! the capture read, which is the only defence against the one concurrent writer
//! the product can neither exclude nor foresee.

pub mod lock;
pub mod txn;

pub use lock::{Expired, Held, Liveness, LivenessProbe, Lock, LockError, Observed, SystemLiveness};
pub use txn::{
    capture, merge_into_file, stage, ApplyError, Capture, Fingerprint, Staged, TxnError,
};
