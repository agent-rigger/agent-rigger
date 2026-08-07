//! What the product asks to be written, what undoes it, and the values a
//! document carries.
//!
//! **Addressed by grammar path, never by line number.** That is what the file
//! plan states, and it is the one thing this module makes structurally true:
//! there exists here no type able to say "at this line", so no implementation
//! can fabricate one without adding the missing type, under a reviewer's eyes.
//!
//! **Three shapes of edit, and a fourth is elsewhere.** The plan gives "these
//! keys at this path", "these values in this array at this path", and "this
//! block between these bounds". The last one lives in [`crate::marker`], and
//! the separation is measured rather than stylistic. A bounded block needs
//! delimiters the document knows how to carry, and the settings document that
//! is served is strict JSON. So its trace is not a variant of the others: it
//! addresses a text document, which no grammar of this crate parses.
//!
//! The third shape here, [`Edit::Element`], is the counterpart of
//! [`Edit::Values`] for a list whose elements are **objects**, and the two do
//! not merge into one. A string carries nowhere to lodge an identity, so the
//! only implementation possible there is recognition by value — a declared
//! limit. An object carries one, so the element is found by an identity that
//! does not depend on its value, which is what makes an update after the
//! catalogue changed its mind possible at all.
//!
//! **An array value is designated by value equality; an object element by its
//! identity. Neither is designated by rank.** An index survives a reordering no
//! better than a line number survives a reformat — that is the original motive
//! for banning positional addressing, applied to one more axis. The host
//! reorders: measured on 2026-08-06 on the host that is served
//! (`docs/specs/socle-neuf/reconnaissance-hotes.md`).

use std::fmt;

use crate::marker::Marker;

/// A value as a document carries it: what the product writes, and what it
/// finds again in order to restore it.
///
/// Numbers are kept under their **original text** rather than converted:
/// `1.50` and `1.5` are the same number and two different documents, and the
/// inverse must return the bytes from before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// A string, decoded.
    Text(String),
    /// A number, under the text the document carried.
    Number(String),
    /// A boolean.
    Bool(bool),
    /// The absence of a value, as the document names it.
    Null,
    /// A list of values.
    List(Vec<Value>),
    /// An object, keys in document order.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// A text value, built from anything that yields one.
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    /// A value that contains no other. Those are what the multiset compared by
    /// the post-condition is made of: comparing a whole object would hide the
    /// disappearance of one of its leaves behind the appearance of another.
    pub fn is_leaf(&self) -> bool {
        !matches!(self, Self::List(_) | Self::Object(_))
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(text) => write!(f, "{text:?}"),
            Self::Number(raw) => write!(f, "{raw}"),
            Self::Bool(value) => write!(f, "{value}"),
            Self::Null => write!(f, "null"),
            Self::List(values) => {
                write!(f, "[")?;
                for (rank, value) in values.iter().enumerate() {
                    if rank > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{value}")?;
                }
                write!(f, "]")
            }
            Self::Object(entries) => {
                write!(f, "{{")?;
                for (rank, (name, value)) in entries.iter().enumerate() {
                    if rank > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{name}: {value}")?;
                }
                write!(f, "}}")
            }
        }
    }
}

/// What the product asks to write into an owned document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    /// "These keys at this path". A key already present has its value
    /// replaced, and the inverse carries what is needed to restore the old one.
    Keys {
        /// The path of the object carrying these keys. Empty for the root.
        path: Vec<String>,
        /// The keys and their values, in the order they are written.
        entries: Vec<(String, Value)>,
    },
    /// "These values in this array at this path". A value already present is
    /// not added and does not enter the trace.
    Values {
        /// The path of the array, last segment included.
        path: Vec<String>,
        /// The values to find there or to put there.
        values: Vec<String>,
    },
    /// "This element, carrying this identity, in this array at this path". The
    /// element is an **object**, and the identity is written inside it.
    ///
    /// **The edit is the same whether the element is there or not**, and that
    /// is what makes it an update rather than a second pose: the element is
    /// looked for by its identity, and only appended when no element carries
    /// it. An edit that appended without looking would leave two elements where
    /// the catalogue declares one, and no later read could say which is which.
    ///
    /// The fields declared here are written; the ones the element already
    /// carries and this edit does not name are **left alone**. The product
    /// removes only what it added, and a field it stops declaring is not a
    /// field it is entitled to destroy.
    Element {
        /// The path of the array, last segment included.
        path: Vec<String>,
        /// The identity lodged inside the element, and the only thing the
        /// element is found by.
        identity: Marker,
        /// The fields the product writes inside the element, in order.
        fields: Vec<(String, Value)>,
    },
}

impl Edit {
    /// "These keys at this path".
    pub fn keys(
        path: &[&str],
        entries: impl IntoIterator<Item = (impl Into<String>, Value)>,
    ) -> Self {
        Self::Keys {
            path: owned_path(path),
            entries: entries
                .into_iter()
                .map(|(name, value)| (name.into(), value))
                .collect(),
        }
    }

    /// "These values in this array at this path".
    pub fn values(path: &[&str], values: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Values {
            path: owned_path(path),
            values: values.into_iter().map(Into::into).collect(),
        }
    }

    /// "This element, carrying this identity, in this array at this path".
    pub fn element(
        path: &[&str],
        identity: Marker,
        fields: impl IntoIterator<Item = (impl Into<String>, Value)>,
    ) -> Self {
        Self::Element {
            path: owned_path(path),
            identity,
            fields: fields
                .into_iter()
                .map(|(name, value)| (name.into(), value))
                .collect(),
        }
    }

    /// The targeted path, as a refusal names it.
    pub fn path(&self) -> &[String] {
        match self {
            Self::Keys { path, .. } | Self::Values { path, .. } | Self::Element { path, .. } => {
                path
            }
        }
    }
}

/// What undoes exactly the edit that produced it — and **nothing else**. What
/// the product did not write does not appear in it, so cannot come out of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inverse {
    /// Remove the keys the edit added, restore those whose value it replaced.
    Keys {
        /// The path of the object.
        path: Vec<String>,
        /// The keys the edit created, to be removed.
        added: Vec<String>,
        /// The keys whose value the edit replaced, and that value.
        replaced: Vec<(String, Value)>,
    },
    /// Remove from the array the values the edit put there, by value equality.
    Values {
        /// The path of the array.
        path: Vec<String>,
        /// The values the edit added.
        added: Vec<String>,
    },
    /// Undo what the edit wrote into the element carrying this identity, found
    /// by that identity and never by its rank.
    Element {
        /// The path of the array.
        path: Vec<String>,
        /// The identity the element carries inside it.
        identity: Marker,
        /// What undoing amounts to, which is not the same thing when the edit
        /// created the element as when it wrote into one already there.
        undo: ElementUndo,
    },
}

/// What undoing an edit on a list element amounts to. Two cases that do not
/// overlap, written as two variants so that no combination of flags can
/// describe a third one that means nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElementUndo {
    /// The edit created the element: undoing it takes the whole element away,
    /// identity included. Nothing of the document from before disappeared, so
    /// the trace records no value.
    Remove,
    /// The edit wrote into an element that was already there — an update. Only
    /// what it wrote is undone, and the element stays.
    Restore {
        /// The fields the edit created inside the element, to be removed.
        added: Vec<String>,
        /// The fields whose value the edit replaced, and that value.
        replaced: Vec<(String, Value)>,
    },
}

impl Inverse {
    /// Nothing to undo: the edit wrote nothing. This is the case of a value
    /// that already existed, which the product therefore did not add and will
    /// never remove.
    ///
    /// An edit on an element is never empty, even when it rewrites the fields
    /// it already held with the same values: the element carries the identity
    /// of the product, so the trace has something to undo — the element itself.
    pub fn is_empty(&self) -> bool {
        match self {
            Self::Keys {
                added, replaced, ..
            } => added.is_empty() && replaced.is_empty(),
            Self::Values { added, .. } => added.is_empty(),
            Self::Element { .. } => false,
        }
    }

    /// The values the document carried and that the trace **records**, that is,
    /// the ones it knows how to restore.
    ///
    /// **Why the post-condition needs this.** The requirement is not that
    /// nothing disappear — an update replaces one value with another, and that
    /// is its purpose. The requirement is that the difference between the
    /// document before and the document after reduce **exactly to what the
    /// trace records**. A replaced value is therefore carried by the trace,
    /// hence undoable; a value that disappeared without appearing in it is not,
    /// and that is the one the post-condition must catch.
    pub fn recorded_values(&self) -> Vec<SemanticValue> {
        let mut values = Vec::new();
        match self {
            Self::Keys { path, replaced, .. } => record_fields(path, replaced, &mut values),
            // An element the edit created carries nothing the document held
            // before, so undoing takes nothing of its owner's away. An update
            // records what it replaced, exactly as a key does.
            Self::Element {
                path,
                undo: ElementUndo::Restore { replaced, .. },
                ..
            } => record_fields(path, replaced, &mut values),
            Self::Values { .. }
            | Self::Element {
                undo: ElementUndo::Remove,
                ..
            } => {}
        }
        values
    }
}

/// Gathers the values of `fields`, each under the path of the field inside
/// `path`. This is the shape a grammar enumerates them in: the elements of an
/// array share the path of the array, so a field of an object element lives at
/// `<path of the array>.<field>`.
pub(crate) fn record_fields(
    path: &[String],
    fields: &[(String, Value)],
    values: &mut Vec<SemanticValue>,
) {
    for (name, value) in fields {
        let mut child_path = path.to_vec();
        child_path.push(name.clone());
        flatten(value, &child_path.join("."), values);
    }
}

/// Gathers the leaf values of a composite value, each with its path — the
/// elements of a list sharing the path of the list, as in the enumeration a
/// grammar returns.
fn flatten(value: &Value, path: &str, values: &mut Vec<SemanticValue>) {
    match value {
        Value::List(elements) => {
            for element in elements {
                flatten(element, path, values);
            }
        }
        Value::Object(entries) => {
            for (name, entry) in entries {
                let child_path = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}.{name}")
                };
                flatten(entry, &child_path, values);
            }
        }
        leaf => values.push(SemanticValue::new(path, leaf.clone())),
    }
}

/// The rendering of an edit and the trace that undoes it, produced by the
/// **same** parse: a second read path would drift from the one that wrote, and
/// the passage the product believes it owns would widen in silence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    /// The document as rendered after the edit.
    pub rendered: String,
    /// What undoes this edit.
    pub inverse: Inverse,
}

/// A value the document carries, and the path where it lives.
///
/// The elements of an array share the path of that array: their rank does not
/// enter their identity, for the same reason it does not enter the identity of
/// an element being removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticValue {
    path: String,
    value: Value,
}

impl SemanticValue {
    /// A value at a path.
    pub fn new(path: impl Into<String>, value: Value) -> Self {
        Self {
            path: path.into(),
            value,
        }
    }

    /// The path where it lives.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// The value itself.
    pub fn value(&self) -> &Value {
        &self.value
    }
}

impl fmt::Display for SemanticValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} = {}", self.path, self.value)
    }
}

/// The values of `before` that the multiset `after` does not contain.
///
/// **A multiset, not a set.** A document may carry the same value twice at the
/// same path — two identical rules in an array — and losing one of them is a
/// loss. Comparing sets would make it invisible.
pub fn values_lost(before: &[SemanticValue], after: &[SemanticValue]) -> Vec<SemanticValue> {
    let mut remaining: Vec<&SemanticValue> = after.iter().collect();
    let mut lost = Vec::new();
    for value in before {
        match remaining.iter().position(|candidate| *candidate == value) {
            Some(rank) => {
                remaining.remove(rank);
            }
            None => lost.push(value.clone()),
        }
    }
    lost
}

fn owned_path(path: &[&str]) -> Vec<String> {
    path.iter().map(|segment| (*segment).to_string()).collect()
}
