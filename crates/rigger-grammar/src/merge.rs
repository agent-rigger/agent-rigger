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
use crate::edit::record_fields;
use crate::element::IDENTITY_KEY;
use crate::{
    values_lost, Applied, Capabilities, Edit, ElementUndo, Grammar, GrammarError, Inverse,
    MergeAdmission, MergeRefusal, SemanticValue, Value,
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
    /// **The post-condition of the removal, on the output.** Replaying the
    /// trace backwards made values disappear that the trace does not name.
    RemovalLostValues {
        /// The grammar that wrote.
        grammar: &'static str,
        /// The values that disappeared, each with its path.
        lost: Vec<SemanticValue>,
    },
    /// **The post-condition of the removal, on the output.** Replaying the
    /// trace backwards destroyed comments the document carried. The product
    /// writes none through this path, so every one of them was its owner's, and
    /// the trace holds nothing able to give them back.
    ///
    /// It is a variant of its own rather than a shade of
    /// [`MergeError::RemovalLostValues`]: a comment is not a leaf, so nothing
    /// that compares values can see it go, and merging the two refusals would
    /// leave a reader unable to tell which of the two witnesses fired.
    RemovalLostComments {
        /// The grammar that wrote.
        grammar: &'static str,
        /// The comments that disappeared, under the raw text the document held.
        lost: Vec<String>,
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
            Self::RemovalLostValues { grammar, lost } => {
                write!(
                    f,
                    "grammar `{grammar}`: replaying this trace backwards made {} value(s) \
                     disappear that the trace does not name —",
                    lost.len()
                )?;
                for value in lost {
                    write!(f, " {value}")?;
                }
                write!(
                    f,
                    ". The transaction aborts: the product takes back only what it put there"
                )
            }
            Self::RemovalLostComments { grammar, lost } => {
                write!(
                    f,
                    "grammar `{grammar}`: replaying this trace backwards destroyed {} comment(s) \
                     the document carried —",
                    lost.len()
                )?;
                for comment in lost {
                    write!(f, " {comment:?}")?;
                }
                write!(
                    f,
                    ". The product writes no comment through this path, so these bytes were its \
                     owner's and the trace holds nothing able to give them back. The transaction \
                     aborts"
                )
            }
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

/// Replays `inverse` backwards on `source` under grammar `G`, and returns the
/// document to write — or says what the removal destroyed, without returning
/// anything at all.
///
/// # Why the removal needs its own post-condition
///
/// [`merge`] proves a pose reversible **against the document it read**: it runs
/// the computed trace backwards on its own rendering and demands the bytes from
/// before. That proof is taken at the moment of the pose, and it is worth
/// exactly what the document is still worth afterwards. Between a pose and its
/// removal the owner writes, and the host that is served rewrites these
/// documents routinely — so what the trace excises at removal time is a passage
/// nobody has proved anything about.
///
/// The gap this closes, measured: a pose adds a key, its owner annotates that
/// very line, the removal takes the key **and the annotation**, gives back a
/// document whose byte count matches the one from before the pose, and reports
/// success. Nothing in [`Grammar::invert`] is wrong; what was missing is a
/// witness on the output, and this is it.
///
/// # The two witnesses, and why there are two
///
/// **The values**, compared as a multiset, before against after: what
/// disappeared must reduce to what the trace names. That is the removal's half
/// of the symmetry — the pose's half lives in [`merge`].
///
/// **The comments**, likewise: a comment is not a leaf, so the comparison of
/// values is blind to it, and it is precisely where an owner's annotation
/// lives. See [`Grammar::comments`] for why every one of them belongs to the
/// owner.
///
/// # What this deliberately does not do
///
/// **It does not consult the admission gate.** The gate keeps a grammar that
/// reformats from writing **new** bytes into a document; asking it again here
/// would let a capability that degrades — a corpus document edited, a library
/// upgraded — make everything already posed unremovable, which is the one
/// outcome this product treats as worse than a refusal to pose.
pub fn unmerge<G: Grammar>(source: &str, inverse: &Inverse) -> Result<String, MergeError> {
    let before = G::values(source)?;
    let comments_before = G::comments(source)?;
    // Read before the write, because it is read **off the document being
    // undone**: for an element the pose created, what the trace is entitled to
    // take back is that element as it stands, and after the write there is
    // nothing left to read it from.
    let accounted = accounted_for::<G>(source, inverse)?;

    let rendered = G::invert(source, inverse)?;

    // Reading the rendering back is what makes the post-condition possible, and
    // it also proves the output can be parsed again: an output its own grammar
    // does not read back is a destroyed document, whatever the rest may say.
    let after = G::values(&rendered)?;
    let lost = accounted.unaccounted(&values_lost(&before, &after));
    if !lost.is_empty() {
        return Err(MergeError::RemovalLostValues {
            grammar: G::NAME,
            lost,
        });
    }

    let comments_after = G::comments(&rendered)?;
    let lost = comments_lost(&comments_before, &comments_after);
    if !lost.is_empty() {
        return Err(MergeError::RemovalLostComments {
            grammar: G::NAME,
            lost,
        });
    }

    Ok(rendered)
}

/// What a removal replaying a given trace is entitled to take out of a
/// document.
///
/// **Two buckets, because a trace names its passage in two ways.** Sometimes it
/// names the values themselves — the strings it added to an array, which it
/// removes by value equality — and those are compared as a multiset, so that a
/// removal taking two identical values where the trace added one is caught.
/// Sometimes it names only a **place** — a key it created, whose value it never
/// recorded because it did not need to — and there everything living at that
/// place, or under it, is the product's to take back.
///
/// Collapsing the two into one would cost the multiset on one side or the
/// precision on the other, and both losses fall on the same document: somebody
/// else's.
struct Accounted {
    values: Vec<SemanticValue>,
    places: Vec<String>,
}

impl Accounted {
    /// The values of `disappeared` this trace does not account for.
    fn unaccounted(&self, disappeared: &[SemanticValue]) -> Vec<SemanticValue> {
        values_lost(disappeared, &self.values)
            .into_iter()
            .filter(|value| !self.covers(value.path()))
            .collect()
    }

    /// Whether `path` is one of the places the trace names, or lives under one.
    fn covers(&self, path: &str) -> bool {
        self.places.iter().any(|place| {
            path == place
                || (path.starts_with(place) && path.as_bytes().get(place.len()) == Some(&b'.'))
        })
    }
}

/// What `inverse` is entitled to take out of `source`.
fn accounted_for<G: Grammar>(source: &str, inverse: &Inverse) -> Result<Accounted, GrammarError> {
    let mut values = Vec::new();
    let mut places = Vec::new();
    match inverse {
        // A key the pose created is removed whole, and a key whose value it
        // replaced gives that value back — in both cases what the trace names
        // is the key, and the trace never recorded what the document currently
        // holds there.
        Inverse::Keys {
            path,
            added,
            replaced,
        } => {
            for name in added {
                places.push(address(path, name));
            }
            for (name, _) in replaced {
                places.push(address(path, name));
            }
        }
        // The strings the pose put in the array, named one by one. The array
        // itself is **not** a place: the values of somebody else live at the
        // very same path, and covering the path would let the removal empty the
        // array with the post-condition looking on.
        Inverse::Values { path, added } => {
            for value in added {
                values.push(SemanticValue::new(path.join("."), Value::text(value)));
            }
        }
        // The pose created the element, so the whole element is the passage it
        // owns — read as it stands, since the trace of a creation records
        // nothing of the document from before. An element the identity no
        // longer finds is not a passage that accounts for nothing: it is a
        // trace replayed against a document that does not carry what it
        // names, and reporting an empty account here would let `unmerge`
        // return `Ok` for a removal that touched nothing it was ever told to.
        Inverse::Element {
            path,
            identity,
            undo: ElementUndo::Remove,
        } => {
            let Some(fields) = G::find_element_by_identity(source, path, identity)? else {
                return Err(GrammarError::element_not_found(G::NAME, path, identity));
            };
            values.push(SemanticValue::new(
                address(path, IDENTITY_KEY),
                Value::text(identity.to_string()),
            ));
            record_fields(path, &fields, &mut values);
        }
        // An update inside an element that a list somebody else owns carries:
        // only the fields the pose wrote there are its own.
        Inverse::Element {
            path,
            undo: ElementUndo::Restore { added, replaced },
            ..
        } => {
            for name in added {
                places.push(address(path, name));
            }
            for (name, _) in replaced {
                places.push(address(path, name));
            }
        }
    }
    Ok(Accounted { values, places })
}

/// The path of `name` inside `path`, in the shape a grammar enumerates values
/// in.
fn address(path: &[String], name: &str) -> String {
    let mut segments = path.to_vec();
    segments.push(name.to_string());
    segments.join(".")
}

/// The comments of `before` that the multiset `after` does not contain.
///
/// **A multiset, not a set.** A document may carry the same comment twice — two
/// `// keep` on two lines — and losing one of them is a loss.
fn comments_lost(before: &[String], after: &[String]) -> Vec<String> {
    let mut remaining: Vec<&String> = after.iter().collect();
    let mut lost = Vec::new();
    for comment in before {
        match remaining.iter().position(|candidate| *candidate == comment) {
            Some(rank) => {
                remaining.remove(rank);
            }
            None => lost.push(comment.clone()),
        }
    }
    lost
}
