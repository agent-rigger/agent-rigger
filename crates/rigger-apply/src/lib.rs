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

//! [`pose`] is the third thing, and it is the one the other two exist for: a
//! behaviour's steps carried out under a transaction that seizes what it is
//! about to change and gives it back if a step fails. The rollback replays that
//! seized state rather than a compensation written per kind of operation, which
//! is what makes it cover the removal of a shared store entry — an operation no
//! such table ever had a line for.

pub mod lock;
pub mod pose;
pub mod txn;

pub use lock::{Expired, Held, Liveness, LivenessProbe, Lock, LockError, Observed, SystemLiveness};
pub use pose::{
    carry, pose, withdraw, LinkProbe, Measured, OnDisk, PoseError, Posted, Practicability,
    StepError, Steps, SystemPracticability,
};
pub use txn::{
    capture, merge_into_file, stage, ApplyError, Capture, Fingerprint, Staged, TxnError,
};

/// MD-40's closing admission: the product will never know at what
/// granularity a host loads what it posed — by file, by directory, or
/// otherwise. This constant carries that sentence for `rigger-cli` to fold
/// into the coverage page — it names a limit of the product itself, not a
/// property any grammar's capability table could carry, which is why it does
/// not live in `rigger_grammar::Capabilities`. It is stated here, in the
/// crate that actually poses files and records their trace, rather than in
/// `rigger-plan`, which is pure and touches no disk.
pub const UNOBSERVED_LOAD_GRANULARITY: &str = "The product poses the files a behaviour names and \
    records their trace; it never asks a host at what granularity — one file, a whole directory, \
    or anything else — that host loads what was posed. So it can never know, and this page can \
    never say, which granularity a host loads by. The structural check this product runs cannot \
    catch it either: that check verifies only that an address is confined and that what a \
    descriptor declares exists, never what a host does with the granularity of what was posed.";
