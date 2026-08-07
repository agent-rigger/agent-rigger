//! An element of a list of objects: the identity the product lodges **inside**
//! it, and the removal that finds it again by that identity.
//!
//! **Where the identity goes is a measurement, not a preference.** Measured on
//! 2026-08-06 on the host that is served: it rewrites its own settings through
//! a round trip across a typed model, which reconstructs the shape it knows. A
//! key it does not know is **destroyed at the root of the document** and
//! **preserved inside an object element** — it rebuilds what it knows at the
//! level where it knows, and passes through the contents of an entry it treats
//! as opaque. An identity written beside the element, or at the root, would
//! therefore be wiped by the first configuration command its owner runs, and
//! the element would become impossible to find again — hence impossible to
//! remove, with no error and nobody noticing.
//!
//! **The rule this module enforces derives from that property of the document,
//! never from the name of a host.** Any writer that round-trips a document
//! through a typed model destroys what it does not know at the level where it
//! knows; the identity goes where such a writer is measured to preserve it.
//!
//! **The identity is the identity of the pose, not the identifier of the
//! entry.** It is the same [`Marker`] a bounded block carries, for the same
//! reason: two catalogues may legitimately publish an entry of the same name,
//! and if they produced the same identity, removing one would take the other's
//! element away — the identity being precisely what told them apart. One type
//! for both shapes, because two would drift, and the drift would show at
//! removal, where it destroys.
//!
//! **A removal reports what diverged, and that report is load-bearing.** The
//! host rewrites these documents, so an element that no longer carries what the
//! product wrote is the common case rather than the corner. What the removal
//! must never do is destroy an owner's edit **in silence**; the post-condition
//! below therefore accounts for what disappeared using the report itself, so a
//! divergence the report fails to name is a divergence the write is refused
//! for.
//!
//! **The post-condition bears on the output.** The input checks say what we
//! thought we understood; reading the rendering back says what we did.

use std::fmt;

use crate::edit::record_fields;
use crate::marker::Marker;
use crate::{values_lost, ElementUndo, Grammar, GrammarError, Inverse, SemanticValue, Value};

/// The field an element carries the identity of the product in.
///
/// **One name, reserved.** A fragment is refused the right to write it — see
/// [`GrammarError::ReservedField`] — because a fragment able to write it could
/// forge an identity, or overwrite the one that tells another catalogue's
/// element apart from its own.
///
/// The value it carries is the identity **in clear**, provenance and entry
/// separated, for the reason a bounded block's marker is legible: it lives in a
/// file its owner opens, and an opaque digest would say "this belongs to the
/// product" without saying to what.
pub const IDENTITY_KEY: &str = "agent-rigger";

/// What the registry records for an element posed in a list of objects: where
/// it is, the identity that finds it again, and the fields the product itself
/// wrote there.
///
/// **The fields are what makes the divergence report possible.** Without them a
/// removal could only take the element away and hope; with them it can say
/// which field is no longer the one it wrote, and name it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElementTrace {
    path: Vec<String>,
    identity: Marker,
    fields: Vec<(String, Value)>,
}

impl ElementTrace {
    /// The trace of an element posed in the array at `path`, carrying
    /// `identity` and the fields the product wrote.
    pub fn new(
        path: &[&str],
        identity: Marker,
        fields: impl IntoIterator<Item = (impl Into<String>, Value)>,
    ) -> Self {
        Self {
            path: path.iter().map(|segment| (*segment).to_string()).collect(),
            identity,
            fields: fields
                .into_iter()
                .map(|(name, value)| (name.into(), value))
                .collect(),
        }
    }

    /// The path of the array the element lives in.
    pub fn path(&self) -> &[String] {
        &self.path
    }

    /// The identity lodged inside the element.
    pub fn identity(&self) -> &Marker {
        &self.identity
    }

    /// The fields the product wrote there.
    pub fn fields(&self) -> &[(String, Value)] {
        &self.fields
    }
}

/// A field of a posed element whose value on disk is not the one the product
/// wrote.
///
/// The three shapes it takes are the three ways a document can have moved: the
/// value changed, the field was taken away, or a field was added to the element
/// by somebody else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDivergence {
    field: String,
    wrote: Option<Value>,
    found: Option<Value>,
}

impl FieldDivergence {
    /// The name of the field.
    pub fn field(&self) -> &str {
        &self.field
    }

    /// What the product wrote there, if it wrote anything.
    pub fn wrote(&self) -> Option<&Value> {
        self.wrote.as_ref()
    }

    /// What the document carries, if it carries anything.
    pub fn found(&self) -> Option<&Value> {
        self.found.as_ref()
    }
}

impl fmt::Display for FieldDivergence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.wrote, &self.found) {
            (Some(wrote), Some(found)) => write!(
                f,
                "the field `{}` carries {found} where the product had written {wrote}",
                self.field
            ),
            (Some(wrote), None) => write!(
                f,
                "the field `{}`, written by the product as {wrote}, is no longer in the element",
                self.field
            ),
            (None, Some(found)) => write!(
                f,
                "the field `{}` carries {found}, and the product never wrote it",
                self.field
            ),
            (None, None) => write!(f, "the field `{}`", self.field),
        }
    }
}

/// A removal that happened: the document to write, and what the element carried
/// that the product had not written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    /// The rendered document, to be written as is.
    pub rendered: String,
    /// Every field of the removed element whose content had diverged from what
    /// the product wrote. Empty when the element was untouched.
    ///
    /// **What is in here is what leaves the document named.** A caller that
    /// drops this report turns a documented removal into a silent destruction.
    pub diverged: Vec<FieldDivergence>,
}

/// Why a removal did not happen. None of these returns a document, so none of
/// them can be written by mistake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveError {
    /// The grammar refused to read or to write, while naming itself. Two
    /// elements carrying the same identity fall here: nothing says which one
    /// the product wrote, so it removes neither.
    Grammar(GrammarError),
    /// No element of the list carries this identity. The product does not guess
    /// at an element to remove — every other element of that list belongs to
    /// somebody else.
    NotFound {
        /// The identity that was looked for.
        identity: Marker,
        /// The path of the list it was looked for in.
        path: String,
    },
    /// **The post-condition on the output.** The write made values disappear
    /// that neither the trace nor the divergence report accounts for. Something
    /// left the document unnamed, which is the one thing a removal must never
    /// do.
    ValuesLost {
        /// The identity being removed.
        identity: Marker,
        /// The values that disappeared, each with its path.
        lost: Vec<SemanticValue>,
    },
    /// **The post-condition on the output.** The rendering still carries an
    /// element with this identity. Reporting the entry as removed would leave a
    /// machine that believes itself clean.
    StillPresent {
        /// The identity still found.
        identity: Marker,
        /// The path of the list.
        path: String,
    },
}

impl From<GrammarError> for RemoveError {
    fn from(err: GrammarError) -> Self {
        Self::Grammar(err)
    }
}

impl fmt::Display for RemoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Grammar(err) => write!(f, "{err}"),
            Self::NotFound { identity, path } => write!(
                f,
                "no element of `{path}` carries the identity `{identity}` — the product does not \
                 guess at an element to remove, since every other one in that list belongs to \
                 somebody else"
            ),
            Self::ValuesLost { identity, lost } => {
                write!(
                    f,
                    "removing the element `{identity}` made {} value(s) disappear that neither its \
                     trace nor the divergence report names —",
                    lost.len()
                )?;
                for value in lost {
                    write!(f, " {value}")?;
                }
                write!(
                    f,
                    ". The transaction aborts: a removal may destroy what its owner changed only \
                     by naming it"
                )
            }
            Self::StillPresent { identity, path } => write!(
                f,
                "after the write, `{path}` still carries an element with the identity \
                 `{identity}` — reporting this entry as removed would leave a machine that \
                 believes itself clean"
            ),
        }
    }
}

impl std::error::Error for RemoveError {}

/// Removes the element the trace describes, and reports what it carried that
/// the product had not written.
///
/// The element is found by its **identity**, never by its rank: the host
/// reorders these lists, measured on 2026-08-06, and a rank designates nothing
/// the moment it does.
pub fn remove<G: Grammar>(source: &str, trace: &ElementTrace) -> Result<Removal, RemoveError> {
    let before = G::values(source)?;

    let Some(found) = G::find_element_by_identity(source, &trace.path, &trace.identity)? else {
        return Err(RemoveError::NotFound {
            identity: trace.identity.clone(),
            path: address(&trace.path),
        });
    };
    let diverged = divergences(&trace.fields, &found);

    // The removal goes through the **one** write path the grammar has, under
    // the trace of a pose that created the element. A second excision written
    // here would drift from the one that writes, and the drift would only show
    // on somebody else's document.
    let rendered = G::invert(
        source,
        &Inverse::Element {
            path: trace.path.clone(),
            identity: trace.identity.clone(),
            undo: ElementUndo::Remove,
        },
    )?;

    // The post-condition, and it bears on the rendering rather than on anything
    // decided above. What may legitimately disappear is the identity, the
    // fields the product wrote, and the fields the report **names**. Anything
    // else left the document unnamed.
    let after = G::values(&rendered)?;
    let disappeared = values_lost(&before, &after);
    let lost = values_lost(&disappeared, &accounted(trace, &diverged));
    if !lost.is_empty() {
        return Err(RemoveError::ValuesLost {
            identity: trace.identity.clone(),
            lost,
        });
    }

    // The other half of the same post-condition, read back with the same
    // search: an element still there after a removal reported as done is an
    // entry nothing will ever remove again.
    if G::find_element_by_identity(&rendered, &trace.path, &trace.identity)?.is_some() {
        return Err(RemoveError::StillPresent {
            identity: trace.identity.clone(),
            path: address(&trace.path),
        });
    }

    Ok(Removal { rendered, diverged })
}

/// What the element carries that the product did not write, and what it wrote
/// that the element no longer carries.
///
/// Fields are matched **by name** and never by rank, for the reason that runs
/// through this whole module: the host reconstructs the shape it knows, and
/// nothing promises it does so in the order it read.
fn divergences(wrote: &[(String, Value)], found: &[(String, Value)]) -> Vec<FieldDivergence> {
    let mut diverged = Vec::new();
    for (name, value) in wrote {
        match found.iter().find(|(other, _)| other == name) {
            Some((_, present)) if present == value => {}
            Some((_, present)) => diverged.push(FieldDivergence {
                field: name.clone(),
                wrote: Some(value.clone()),
                found: Some(present.clone()),
            }),
            None => diverged.push(FieldDivergence {
                field: name.clone(),
                wrote: Some(value.clone()),
                found: None,
            }),
        }
    }
    for (name, present) in found {
        if !wrote.iter().any(|(other, _)| other == name) {
            diverged.push(FieldDivergence {
                field: name.clone(),
                wrote: None,
                found: Some(present.clone()),
            });
        }
    }
    diverged
}

/// The values whose disappearance the removal accounts for: the identity, what
/// the product wrote, and what the report names.
///
/// **The report is part of the accounting, and that is the point.** Were the
/// values simply read off the element being removed, the post-condition would
/// pass whether or not the report named anything, and "does not destroy an
/// owner's change without naming it" would be a promise nothing measured.
fn accounted(trace: &ElementTrace, diverged: &[FieldDivergence]) -> Vec<SemanticValue> {
    let mut values = vec![SemanticValue::new(
        identity_address(&trace.path),
        Value::Text(trace.identity.to_string()),
    )];
    record_fields(&trace.path, &trace.fields, &mut values);
    let named: Vec<(String, Value)> = diverged
        .iter()
        .filter_map(|divergence| {
            divergence
                .found
                .clone()
                .map(|value| (divergence.field.clone(), value))
        })
        .collect();
    record_fields(&trace.path, &named, &mut values);
    values
}

/// The path of a list, as a refusal names it.
fn address(path: &[String]) -> String {
    if path.is_empty() {
        "(root)".to_string()
    } else {
        path.join(".")
    }
}

/// The path the identity lives at, in the shape a grammar enumerates values in:
/// the elements of an array share the path of the array.
fn identity_address(path: &[String]) -> String {
    let mut segments = path.to_vec();
    segments.push(IDENTITY_KEY.to_string());
    segments.join(".")
}
