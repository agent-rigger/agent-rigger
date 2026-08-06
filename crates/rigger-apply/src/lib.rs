//! L'écriture d'un document possédé : ce que `rigger-grammar` ne peut pas
//! porter parce qu'elle est pure, et que le plan de fichiers range ici.
//!
//! **Ce qui n'est pas encore ici.** Le verrou entre processus
//! (`crates/rigger-apply/src/lock.rs`) appartient à cette caisse et arrive
//! avec la famille A. Son absence ne rend pas ce module inutile, et c'est le
//! fond de C8 : le verrou exclut d'autres exécutions **du produit**, il ne
//! peut rien contre l'hôte, qui réécrit ses propres fichiers de réglages —
//! mesuré le 2026-08-06, et routinier. La garde d'empreinte est la seule
//! défense contre le seul écrivain concurrent que le produit ne peut ni
//! exclure ni prévoir.

pub mod txn;

pub use txn::{
    capture, merge_into_file, stage, ApplyError, Capture, Fingerprint, Staged, TxnError,
};
