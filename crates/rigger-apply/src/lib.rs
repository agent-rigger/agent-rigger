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
///
/// **This text says what the product does not do, and never what it checks.**
/// An earlier wording added that "the structural check this product runs
/// verifies only that an address is confined and that what a descriptor
/// declares exists". No such check exists: the address type validates UTF-8
/// and nothing else, and there is no descriptor and no catalogue reader in any
/// crate here. That sentence came from the failure register, where it describes
/// a check the target model is to build, and putting it in the present tense
/// gave a published page a claim about confinement that a reader could take for
/// a guarantee against path traversal.
///
/// **Nothing in this page can go red on a false claim**, which is why the
/// wording carries the weight. The command's test compares the binary's output
/// to the committed file, and both come from this constant — the text is only
/// ever compared to itself. A page of declared limits that overstates what the
/// product does is worse than one that says nothing, and no instrument here
/// will catch the difference. State an absence; never a capability.
pub const UNOBSERVED_LOAD_GRANULARITY: &str = "The product poses the files a behaviour names and \
    records their trace; it never asks a host anything about what becomes of them afterwards. So \
    it cannot know, and this page cannot say, whether what it posed is read one file at a time, \
    as a whole directory, or at all.";
