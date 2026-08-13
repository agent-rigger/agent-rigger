//! The grammar boundary: what the product can read from, and render back to, a
//! document somebody else owns. This crate knows nothing of assistants, of
//! catalogues, or of the registry.
//!
//! This crate's design puts, in this module, a trait carrying `parse`,
//! `apply(Edit) -> Inverse` and `render`, addressed by grammar path and never
//! by line number. The exact shapes of `Edit` and `Inverse` were meant to come
//! out of the write-grammar scenarios: they did, and they live in [`edit`].
//!
//! The shape of trace "this block between these bounds" lives in [`marker`],
//! apart from [`Edit`] and [`Inverse`], and the separation is measured rather
//! than stylistic: a bounded block needs delimiters the document knows how to
//! carry, and the settings document that is served is strict JSON. The
//! documents that shape has an object on are the text ones, which no grammar of
//! this crate parses.
//!
//! [`element`] carries what a list whose elements are **objects** needs and
//! [`Edit::Values`] cannot give: an element found by an identity lodged inside
//! it, hence independent of its value. The [`marker::Marker`] identifying a
//! bounded block identifies such an element too — one type, because what it
//! names is the same thing and two definitions of it would drift.
//!
//! **What is not here, and why.** The crate performs **no input or output**:
//! the conditional write of an owned document lives in `rigger-apply`, because
//! this plan wants this crate pure.

pub mod capability;
pub mod coverage;
pub mod edit;
pub mod element;
pub mod jsonc;
pub mod marker;
pub mod merge;
pub mod toml;

pub use capability::{
    mutations, table, Capabilities, GrammarRole, MergeAdmission, MergeForm, MergeRefusal,
    RefusalReason, Resolution, TriviaDivergence, SHARED_CORPUS,
};
pub use edit::{values_lost, Applied, Edit, ElementUndo, Inverse, SemanticValue, Value};
pub use jsonc::Jsonc;
pub use merge::{merge, unmerge, MergeError, Merged};
pub use toml::Toml;

use std::fmt;

/// Text that is a document in none of the grammars served: neither a JSON
/// value, nor a TOML key line. One single shape for all of them, because the
/// property is common and because one shape per grammar would suggest that the
/// refusal depends on the way the document was broken.
///
/// The capability derivation uses it as proof that a parser exists, and
/// `tests/conformance.rs` as proof of a named refusal: one definition, because
/// two would drift apart.
pub const NOT_A_DOCUMENT: &str = "!!! this is not a document !!!\n";

/// The document a capability is measured on. It belongs to the grammar,
/// because it is written in its syntax, and it carries hostile trivia: a
/// watered-down probe would make the measurement trivially true.
#[derive(Debug, Clone, Copy)]
pub struct Probe {
    /// The document, in the syntax of the grammar.
    pub source: &'static str,
    /// A fragment of a **comment** present in `source`.
    ///
    /// Of the three dimensions of hostile trivia the derivation demands, two
    /// can be recognised without knowing anything about the grammar — the CRLF
    /// line ending and the indentation. The third has a syntax that changes
    /// from one grammar to the next, so it is declared here. The declaration
    /// is not taken on trust: the derivation strips this fragment from the
    /// document and demands that it still be readable. A fragment whose
    /// removal breaks the read is **data**, not a comment, and the probe then
    /// does not carry the dimension it claims to carry.
    pub comment: &'static str,
    /// The path of a list of strings present in `source`.
    pub list_path: &'static [&'static str],
    /// A value that list contains.
    pub value_present: &'static str,
    /// A value that list does not contain.
    pub value_absent: &'static str,
}

/// What a grammar refuses, while naming itself. A refusal that does not name
/// the grammar leaves its reader searching, and that is the mode the registry
/// records as "silent refusal".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrammarError {
    /// The document is not readable by this grammar.
    Malformed {
        /// The grammar that refuses.
        grammar: &'static str,
        /// What the parsing library reported.
        detail: String,
    },
    /// The requested operation has no implementation in this grammar.
    Unsupported {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The requested operation, named.
        operation: &'static str,
    },
    /// The targeted path does not exist in the document, or does not have the
    /// shape the edit assumes. The product refuses rather than fabricate the
    /// missing structure: it writes only where existence has been observed,
    /// never where it has just invented something.
    PathNotFound {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The requested path, as it was written.
        path: String,
    },
    /// The document defines the same key more than once on the path being
    /// read, and the format does not say which one a reader honours. The
    /// product refuses rather than pick one: writing into the one that is not
    /// honoured would be ineffective with no error and no trace.
    Ambiguous {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The key defined more than once.
        key: String,
        /// The number of definitions found.
        occurrences: usize,
    },
    /// More than one element of the same list carries the same identity of the
    /// product. Nothing says which one it wrote, so it claims neither: picking
    /// one would be removing an element from a list somebody else owns on a
    /// coin toss, which is the one damage this crate treats as irreversible.
    DuplicatedIdentity {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The path of the list.
        path: String,
        /// The identity found more than once.
        identity: String,
        /// The number of elements carrying it.
        occurrences: usize,
    },
    /// The edit declares the field a list element carries the identity of the
    /// product in. Writing it would let a fragment forge an identity, or
    /// overwrite the one that tells another catalogue's element apart from its
    /// own — and the identity is precisely what keeps a removal from taking the
    /// wrong element.
    ReservedField {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The reserved field the edit declared.
        field: &'static str,
    },
    /// No element of the list at `path` carries `identity`. A search for an
    /// element by its identity found none — the document no longer carries
    /// what was posed there, whether because it was already removed or
    /// because its owner rewrote that passage away.
    ///
    /// **This is not the same fact as an empty account.** A caller reading a
    /// list element in order to say what a removal may take is entitled to
    /// nothing when the element is gone, and nothing is not the same value as
    /// the element's fields: collapsing the two would let a removal report an
    /// empty account for a passage it never found, which is indistinguishable
    /// from a passage that was legitimately empty. The refusal keeps the two
    /// apart.
    ElementNotFound {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The path of the list it was looked for in.
        path: String,
        /// The identity that was looked for.
        identity: String,
    },
    /// The array at `path` does not contain `value`. A trace named a value it
    /// added, by equality, and the document no longer carries it — whether
    /// because it was already removed or because its owner rewrote that
    /// array away.
    ///
    /// **The same fact as [`Self::ElementNotFound`], for the other trace
    /// shape.** An array named by equality has no identity to look up, so the
    /// value itself is what the search is for; the refusal names it for the
    /// same reason `ElementNotFound` names the identity — a caller reading
    /// this is entitled to nothing when the value is gone, and nothing is
    /// not the same as an empty account.
    ValueNotFound {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The path of the array it was looked for in.
        path: String,
        /// The value that was looked for.
        value: String,
    },
    /// The object at `path` does not carry `key`. A trace named a key it
    /// created, or one whose value it replaced, and the document no longer
    /// carries it — its owner deleted it between the pose and this replay.
    ///
    /// **The same fact again, for the third and most common trace shape.**
    /// [`Self::ElementNotFound`] and [`Self::ValueNotFound`] each close one arm
    /// of the same hole, and this closes the last: a trace replayed against a
    /// document that does not carry what it names is entitled to nothing, and
    /// nothing is not an empty account.
    ///
    /// **On a replaced key it refuses a write, not a silence.** Undoing a
    /// replacement means putting the earlier value back, and that inversion is
    /// defined only while the document still holds what the pose left there.
    /// Once the key is gone, writing the earlier value back does not undo a
    /// pose — it creates a key a person removed, out of bytes this product
    /// never posed. Nothing downstream would catch it either: a removal's
    /// post-condition compares what **disappeared**, so a key that **appears**
    /// passes every check made here.
    KeyNotFound {
        /// The grammar that refuses.
        grammar: &'static str,
        /// The path of the object it was looked for in.
        path: String,
        /// The key that was looked for.
        key: String,
    },
}

impl GrammarError {
    /// Read refusal, naming the grammar and what the parse reported.
    pub fn malformed(grammar: &'static str, detail: impl fmt::Display) -> Self {
        Self::Malformed {
            grammar,
            detail: detail.to_string(),
        }
    }

    /// Operation refusal, naming the grammar and the operation.
    pub fn unsupported(grammar: &'static str, operation: &'static str) -> Self {
        Self::Unsupported { grammar, operation }
    }

    /// Addressing refusal, naming the grammar and the requested path.
    pub fn path_not_found(grammar: &'static str, path: &[String]) -> Self {
        Self::PathNotFound {
            grammar,
            path: if path.is_empty() {
                "(root)".to_string()
            } else {
                path.join(".")
            },
        }
    }

    /// Arbitration refusal, naming the grammar, the key, and how many times it
    /// is defined.
    pub fn ambiguous(grammar: &'static str, key: impl Into<String>, occurrences: usize) -> Self {
        Self::Ambiguous {
            grammar,
            key: key.into(),
            occurrences,
        }
    }

    /// Identity refusal, naming the grammar, the list, the identity, and how
    /// many elements carry it.
    pub fn duplicated_identity(
        grammar: &'static str,
        path: &[String],
        identity: impl fmt::Display,
        occurrences: usize,
    ) -> Self {
        Self::DuplicatedIdentity {
            grammar,
            path: if path.is_empty() {
                "(root)".to_string()
            } else {
                path.join(".")
            },
            identity: identity.to_string(),
            occurrences,
        }
    }

    /// Search refusal, naming the grammar, the list, and the identity no
    /// element of it carries.
    pub fn element_not_found(
        grammar: &'static str,
        path: &[String],
        identity: impl fmt::Display,
    ) -> Self {
        Self::ElementNotFound {
            grammar,
            path: if path.is_empty() {
                "(root)".to_string()
            } else {
                path.join(".")
            },
            identity: identity.to_string(),
        }
    }

    /// Search refusal, naming the grammar, the array, and the value no
    /// element of it carries.
    pub fn value_not_found(
        grammar: &'static str,
        path: &[String],
        value: impl fmt::Display,
    ) -> Self {
        Self::ValueNotFound {
            grammar,
            path: if path.is_empty() {
                "(root)".to_string()
            } else {
                path.join(".")
            },
            value: value.to_string(),
        }
    }

    /// Search refusal, naming the grammar, the object, and the key it does not
    /// carry.
    pub fn key_not_found(grammar: &'static str, path: &[String], key: impl fmt::Display) -> Self {
        Self::KeyNotFound {
            grammar,
            path: if path.is_empty() {
                "(root)".to_string()
            } else {
                path.join(".")
            },
            key: key.to_string(),
        }
    }

    /// The grammar that refused.
    pub fn grammar(&self) -> &'static str {
        match self {
            Self::Malformed { grammar, .. }
            | Self::Unsupported { grammar, .. }
            | Self::PathNotFound { grammar, .. }
            | Self::Ambiguous { grammar, .. }
            | Self::DuplicatedIdentity { grammar, .. }
            | Self::ReservedField { grammar, .. }
            | Self::ElementNotFound { grammar, .. }
            | Self::ValueNotFound { grammar, .. }
            | Self::KeyNotFound { grammar, .. } => grammar,
        }
    }
}

impl fmt::Display for GrammarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed { grammar, detail } => {
                write!(f, "grammar `{grammar}`: malformed document — {detail}")
            }
            Self::Unsupported { grammar, operation } => {
                write!(f, "grammar `{grammar}`: {operation} is not implemented")
            }
            Self::PathNotFound { grammar, path } => write!(
                f,
                "grammar `{grammar}`: the path `{path}` does not exist in this document, and the \
                 product does not fabricate the structure that is missing"
            ),
            Self::Ambiguous {
                grammar,
                key,
                occurrences,
            } => write!(
                f,
                "grammar `{grammar}`: the key `{key}` is defined {occurrences} times on the path \
                 being read — the format does not say which one is honoured on read, and the \
                 product does not choose in its place"
            ),
            Self::DuplicatedIdentity {
                grammar,
                path,
                identity,
                occurrences,
            } => write!(
                f,
                "grammar `{grammar}`: {occurrences} elements of `{path}` carry the identity \
                 `{identity}` — nothing says which one the product wrote, and it removes an \
                 element from a list somebody else owns on no coin toss"
            ),
            Self::ReservedField { grammar, field } => write!(
                f,
                "grammar `{grammar}`: the field `{field}` carries the identity of an element and \
                 is written by the product alone — a fragment able to write it could forge an \
                 identity, or overwrite the one that tells another catalogue's element apart"
            ),
            Self::ElementNotFound {
                grammar,
                path,
                identity,
            } => write!(
                f,
                "grammar `{grammar}`: no element of `{path}` carries the identity `{identity}` — \
                 the document no longer carries what was posed there"
            ),
            Self::ValueNotFound {
                grammar,
                path,
                value,
            } => write!(
                f,
                "grammar `{grammar}`: the array `{path}` does not carry the value `{value}` — the \
                 document no longer carries what was posed there"
            ),
            Self::KeyNotFound { grammar, path, key } => write!(
                f,
                "grammar `{grammar}`: the object `{path}` does not carry the key `{key}` — the \
                 document no longer carries what was posed there"
            ),
        }
    }
}

impl std::error::Error for GrammarError {}

/// A writing or reading grammar, seen from what the capability table must be
/// able to **execute** in order to answer questions about it.
///
/// The two capabilities this trait serves — preserving trivia, designating a
/// list element — are not declared: they are measured by running the
/// implementation on [`Probe`]. Since the probe belongs to the grammar being
/// judged, the measurement demands more of it than the round trip alone: see
/// the derivation in [`capability`], which says what those trials guarantee
/// and what they do not.
///
/// Two terms do not execute, each for its own reason. [`Resolution`] describes
/// how the document is **resolved by whoever reads it**, which is measured on
/// that reader and cited, never guessed. [`GrammarRole`] says what the product
/// allows itself to write, which is a **decision** and not a measurement. Every
/// implementation must give, for one as for the other, its dated source.
pub trait Grammar {
    /// The name this grammar is named by in a refusal.
    const NAME: &'static str;

    /// What the product allows itself to do with documents of this grammar.
    /// A product decision, dated and sourced by the implementation.
    const ROLE: GrammarRole;

    /// How sensitive to order the resolution of documents of this grammar is.
    /// A measured fact, cited by the implementation.
    const RESOLUTION: Resolution;

    /// The document the executable capabilities are measured on.
    const PROBE: Probe;

    /// Parses then renders, with no edit at all. The rendering must be
    /// byte-for-byte identical to the input when the grammar preserves trivia.
    fn round_trip(source: &str) -> Result<String, GrammarError>;

    /// Says whether the list of strings at `path` contains `value`. An element
    /// is designated by value equality and never by index — an index survives
    /// a reordering no better than a line number survives a reformat.
    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError>;

    /// The fields of the element of the list at `path` that carries `identity`
    /// **inside** it, or `None` when no element does. The identity itself is
    /// not among them: it is what was searched for, not something the product
    /// reports having written.
    ///
    /// **Inside the element, never beside it.** Measured on 2026-08-06 on the
    /// host that is served: it destroys a key it does not know at the root of
    /// the document, and preserves one inside an object element. An identity
    /// written anywhere else does not survive the first configuration command
    /// its owner runs, and an element that cannot be found again cannot be
    /// removed.
    ///
    /// **By identity, never by rank, and never by value.** A rank designates
    /// nothing once the host has reordered the list, which it does. A value
    /// designates nothing once the catalogue has published a different one,
    /// which is the whole reason an element needs an identity at all.
    ///
    /// Two elements carrying the same identity make this refuse: nothing says
    /// which of them the product wrote.
    fn find_element_by_identity(
        _source: &str,
        _path: &[String],
        _identity: &marker::Marker,
    ) -> Result<Option<Vec<(String, Value)>>, GrammarError> {
        Err(GrammarError::unsupported(
            Self::NAME,
            "finding a list element by its identity",
        ))
    }

    /// Applies `edit` to `source` and returns the edited document **together
    /// with** the trace that undoes it, both produced by the same parse.
    ///
    /// **Refusal by default is the substance of this method.** A grammar that
    /// does not write it declares itself to have no write path, and the
    /// capability derivation refuses it the `merge` behaviour while naming that
    /// — which is how a `ReadWrite` role announced without an implementation
    /// stops being tenable. What this default does **not** do is take a grammar
    /// at its word: it makes it measure as writing nothing, which is what it is.
    fn apply(_source: &str, _edit: &Edit) -> Result<Applied, GrammarError> {
        Err(GrammarError::unsupported(Self::NAME, "applying an edit"))
    }

    /// Undoes an edit and returns the document as it was before.
    ///
    /// The property the derivation demands: `apply` then `invert` returns the
    /// pre-image **byte for byte**. An inverse that returns an equivalent but
    /// reformatted document destroys the owner's work on removal, that is, at
    /// the exact spot where nobody is looking.
    ///
    /// **This property is not taken on trust, and cannot be.** It holds of a
    /// (document, edit) pair, not of a grammar: the same implementation keeps
    /// it on a key whose value is a string and loses it on a key whose value
    /// carries a comment. What the derivation and the corpus measure is
    /// therefore a sample; what **decides** is [`merge`], which runs this very
    /// inverse on that very rendering and refuses the write when the bytes from
    /// before do not come back.
    fn invert(_source: &str, _inverse: &Inverse) -> Result<String, GrammarError> {
        Err(GrammarError::unsupported(Self::NAME, "undoing an edit"))
    }

    /// The values the document carries, each with its path.
    ///
    /// This is the witness of the post-condition: the multiset from before must
    /// be included in the one from after, failing which the write destroyed a
    /// value the user had written.
    fn values(_source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Err(GrammarError::unsupported(
            Self::NAME,
            "enumerating the values of the document",
        ))
    }

    /// The comments the document carries, in document order, each under the raw
    /// text the document holds.
    ///
    /// **This is the second witness of the removal's post-condition, and it
    /// exists because the first one is blind to it.** [`Grammar::values`]
    /// enumerates leaves; a comment is not one, so a removal that destroys a
    /// comment leaves the comparison of values silent — which is exactly the
    /// gap [`unmerge`] closes.
    ///
    /// **Every comment in these documents belongs to its owner.** [`Edit`]
    /// carries no shape that writes one, and no variant of [`Value`] is a
    /// comment, so nothing the product writes through this path can put one
    /// there. A comment that disappears while a trace is replayed backwards is
    /// therefore its owner's work destroyed, and the trace holds nothing able
    /// to give it back. That reasoning is a property of the types above, not a
    /// list of the documents we happen to have seen — which is why it keeps
    /// holding the day a new grammar arrives.
    ///
    /// Refusal by default, like the write path: a grammar that cannot say what
    /// comments its documents carry cannot show that a removal spared them.
    fn comments(_source: &str) -> Result<Vec<String>, GrammarError> {
        Err(GrammarError::unsupported(
            Self::NAME,
            "enumerating the comments of the document",
        ))
    }
}
