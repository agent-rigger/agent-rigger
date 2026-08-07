//! The `merge` behaviour in the form "these keys at this path", in its **pure**
//! part: the admission gate, the edit, and the post-condition on the output. No
//! input or output here — the conditional write of the document belongs to the
//! crate that carries it.
//!
//! The other form, "this block between these bounds", is written by
//! [`crate::marker`] and admitted by its own gate: the two are refused for
//! different reasons, and neither refusal says anything about the other.
//!
//! **Three steps, in this order, and the order is the substance.**
//!
//! The admission gate first: a grammar whose implementation does not return the
//! bytes outside the trace must not reach the document. The refusal therefore
//! falls **before** a rendering exists, and a fortiori before it replaces
//! anything.
//!
//! The edit next, on the structure of the grammar.
//!
//! The post-condition last, and it bears **on the output**. What the input
//! checks say is what we thought we understood; what the post-condition says is
//! what we did. It compares the semantic values from before and after:
//! observing the presence of what we added says **nothing** about what we
//! destroyed, and it is through that hole that a value written by the user left
//! an array.
//!
//! **It has two halves, and the second is in bytes.** Comparing semantic values
//! sees leaves only: a comment, an indentation, an escape are not leaves, so
//! their disappearance leaves it silent. C1 demands the opposite — the
//! difference between the document before and the document after must reduce
//! **exactly** to what the trace records, otherwise the transaction aborts. The
//! only way to observe that without assuming it is to **undo the write we have
//! just computed** and compare the bytes to those from before. That is what the
//! capability derivation demands of a grammar on its probe; here, the same
//! trial bears on the user's document, which nobody chose.
//!
//! What this half catches and nothing else caught: the trace of a replaced key
//! records only the **semantic** value of its pre-image, so a comment living
//! inside that value was destroyed on write and never restored on removal. The
//! refusal now falls before the document is replaced, and it falls for any
//! write that does not undo — not only for the ones we would have thought of.

use std::fmt;

use crate::capability::TriviaDivergence;
use crate::{
    values_lost, Applied, Capabilities, Edit, Grammar, GrammarError, Inverse, MergeAdmission,
    MergeRefusal, SemanticValue,
};

/// What a successful merge returns: the document to write, and the trace that
/// undoes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    /// The rendered document, to be written as is.
    pub rendered: String,
    /// What undoes this merge.
    pub inverse: Inverse,
}

/// Why a merge did not happen. None of these four variants leaves a document
/// replaced: the first falls before any rendering, the others return a document
/// that never left memory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeError {
    /// The grammar is not admitted to the `merge` behaviour.
    NotAdmitted(MergeRefusal),
    /// The grammar refused to read or to write, while naming itself.
    Grammar(GrammarError),
    /// The post-condition observed the disappearance of values the document
    /// carried before the edit.
    ValuesLost {
        /// The grammar that wrote.
        grammar: &'static str,
        /// The values that disappeared, with their path.
        lost: Vec<SemanticValue>,
    },
    /// The computed trace does not return the document from before byte for
    /// byte. The write would therefore be irreversible, and the gap bears on
    /// what the trace does not record — a comment, an indentation, an escape.
    PreimageNotRestored {
        /// The grammar that wrote.
        grammar: &'static str,
        /// What diverged between the pre-image and what the trace returns.
        divergence: TriviaDivergence,
    },
}

impl From<GrammarError> for MergeError {
    fn from(err: GrammarError) -> Self {
        Self::Grammar(err)
    }
}

impl fmt::Display for MergeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAdmitted(refusal) => write!(f, "{refusal}"),
            Self::Grammar(err) => write!(f, "{err}"),
            Self::ValuesLost { grammar, lost } => {
                write!(
                    f,
                    "grammar `{grammar}`: the write made {} value(s) the document carried \
                     disappear —",
                    lost.len()
                )?;
                for value in lost {
                    write!(f, " {value}")?;
                }
                Ok(())
            }
            Self::PreimageNotRestored {
                grammar,
                divergence,
            } => write!(
                f,
                "grammar `{grammar}`: this write does not undo — the computed trace does not \
                 return the document from before, {divergence}. The transaction aborts rather \
                 than write into an owned document something it would not know how to remove"
            ),
        }
    }
}

impl std::error::Error for MergeError {}

/// Merges `edit` into `source` under grammar `G`.
///
/// Returns the document to write and its inverse trace, or says why there is
/// none — without ever returning a partially edited document: a merge that
/// fails returns nothing at all, and that is what makes aborting the default
/// conduct rather than a conduct every caller has to write.
pub fn merge<G: Grammar>(source: &str, edit: &Edit) -> Result<Merged, MergeError> {
    // The gate is queried on every call, and its answer is **measured**, not
    // read from a table computed elsewhere: the repository corpus is traversed
    // again. The cost is that of a handful of settings documents, and it is
    // paid so that the table cannot be wrong between the moment it is computed
    // and the moment it is used. The day it weighs, the remedy is a cache —
    // hence an invalidation to write, and a reason not to do it before having
    // measured.
    match Capabilities::of::<G>().merge_by_keys() {
        MergeAdmission::Admitted => {}
        MergeAdmission::Refused(refusal) => return Err(MergeError::NotAdmitted(refusal.clone())),
    }

    let before = G::values(source)?;
    let Applied { rendered, inverse } = G::apply(source, edit)?;

    // Reading the rendering back is what makes the post-condition possible, and
    // it also proves the output can be parsed again: an output its own grammar
    // does not read back is a destroyed document, whatever the rest may say.
    let after = G::values(&rendered)?;
    // What the trace records is subtracted from what disappeared: the
    // difference must reduce **exactly** to the trace, no more — a value
    // destroyed outside the trace cannot be removed — and no less — an update
    // replaces a value, and that is its purpose.
    let disappeared = values_lost(&before, &after);
    let lost = values_lost(&disappeared, &inverse.recorded_values());
    if !lost.is_empty() {
        return Err(MergeError::ValuesLost {
            grammar: G::NAME,
            lost,
        });
    }

    // The second half of the post-condition, in bytes: the trace is **run** on
    // the rendering, and what it returns must be the document from before. A
    // trace that does not return the pre-image describes an irreversible write,
    // and the gap falls exactly where comparing semantic values is blind — a
    // comment, an indentation, an escape are not leaves.
    //
    // It comes **after** the comparison of values, and that order is
    // substantive: a write that destroys a user's value must be refused by
    // naming that value, which is what its owner recognises, rather than by
    // naming an offset.
    match G::invert(&rendered, &inverse) {
        Err(err) => return Err(MergeError::Grammar(err)),
        Ok(undone) => {
            if let Some(divergence) = TriviaDivergence::measure(source, &undone) {
                return Err(MergeError::PreimageNotRestored {
                    grammar: G::NAME,
                    divergence,
                });
            }
        }
    }

    Ok(Merged { rendered, inverse })
}
