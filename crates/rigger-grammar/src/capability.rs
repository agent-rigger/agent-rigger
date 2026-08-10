//! The table of what each grammar can express, **derived from the
//! implementations** wherever that can be measured, and declared with its
//! source where it cannot.
//!
//! **The entire point of this module.** Answering "does this grammar preserve
//! trivia?" **runs** the round trip on the grammar's probe and compares bytes.
//! Answering "can it designate a list element?" **runs** the search. There
//! exists no constructor of [`Capabilities`] other than [`Capabilities::of`]: a
//! capability cannot be **announced** anywhere other than where it is
//! **executed**. That is what slice T3a exists to close — a characterization
//! test describes a limit, it does not impose one.
//!
//! **What the derivation guarantees, and what it does not.** The sentence "a
//! capability announced without an implementation is impossible to write" once
//! stood here, and it was false: both the probe and the round trip are supplied
//! by the grammar being judged, so an implementation returning its input
//! unchanged on a watered-down probe credited itself with everything. What
//! `measure_trivia` demands costs something to anyone who would try again —
//! three dimensions of hostile trivia in the probe, a comment fragment whose
//! optionality is **executed**, and the refusal of things that are not
//! documents, which is what tells a parser apart from an identity function.
//!
//! **Two things the probe alone could not close, and which are closed here.**
//! Both have the same cause: what the measurement bore on was chosen by the
//! very thing it judges.
//!
//! *A probe carries only the trivia its author puts in it.* The three required
//! dimensions name categories, not shapes: a grammar whose rendering destroys
//! **block** comments, with a probe carrying only a line comment, passed all
//! three and credited itself with preservation. The measurement therefore also
//! bears on [`SHARED_CORPUS`], the documents of the repository — which the
//! author of a grammar does not choose, whose traps are guarded by
//! `tests/conformance.rs`, and which **every** grammar is offered whatever
//! their extension. What a grammar reads of them, it must render back to the
//! byte; and a grammar that reads none of them is measured only against itself,
//! hence is not measured.
//!
//! *A refusal can be counterfeited.* Refusing a document prefixed with a public
//! constant requires no ability to read: `starts_with` is enough, and an
//! identity function was thereby credited with having a parser. The documents
//! whose refusal is demanded are therefore **derived from the document
//! itself** — see [`mutations`]: followed by what is not a document, and
//! concatenated with itself, two shapes that begin with the same bytes as the
//! original and that only reading the structure tells apart.
//!
//! None of these trials makes cheating impossible: the repository corpus is
//! readable, and its mutations can be enumerated by anyone willing to hard-code
//! them. All of them make it visible and costly, and none is satisfied any
//! longer by a document the author of the grammar brought along.
//!
//! **Two terms do not execute.** The order sensitivity of [`Resolution`] is a
//! property of whoever reads the document, not of the code that writes it. The
//! [`GrammarRole`] is a product **decision** about what the product allows
//! itself to write, not a measurement. Both are declared by each grammar with
//! its dated source, and the admission decision reads them in this table —
//! never in a list of host names.
//!
//! **`merge` has two forms, and they are admitted separately.** "These keys at
//! this path" is refused where the position of a key decides what a reader
//! honours; "this block between these bounds" is refused where the document has
//! no way of carrying a delimiter. Neither refusal implies the other, and a
//! refusal that published only one of them would tell its reader that the other
//! road is open — which is the whole point of the fourth case, the one where
//! both difficulties meet and neither road is. No grammar served today reunites
//! them, so nothing but a rule derived from the two properties would refuse the
//! day one does.
//!
//! The second capacity is **measured** like the rest, by [`measure_delimiters`]:
//! a block is **posed** — by the very function a pose runs — into every document
//! the grammar reads, and what comes out must still be a document that grammar
//! reads. Writing a bounded block goes through no [`Grammar`] — see
//! [`crate::marker`] — but being able to carry one is a property of the
//! document's format, and admission must read one table rather than two.
//!
//! **The answer is by wrapping, and it is published that way.** A pose writes
//! four, and they are not carried alike by the same document: a comment is a
//! comment where a bare token is a syntax error. A single boolean folded by
//! "at least one of them" hands a caller a "yes" that names no road, and the
//! caller then picks the wrapping the trial had measured as destroying the
//! file. [`Capabilities::delimiter_wrappings`] therefore carries the set, and
//! the boolean is derived from it rather than the other way round.

use std::fmt;

use crate::marker::{self, Marker, Pose, Wrapping};
use crate::{Grammar, Jsonc, Toml};

/// The documents of the repository, embedded in the crate: the second witness
/// of the derivation, and the only one not supplied by the grammar being
/// judged.
///
/// **Why they live in the library and not in a test.** T3a asks that the
/// admission gate be **mechanical** — declared per grammar, derived from the
/// implementation, never announced by hand — and a table that is wrong while a
/// test goes red is still a table that is wrong for whoever calls it. The
/// measurement therefore needs the documents at the moment it answers, not at
/// the moment the suite runs.
///
/// **Why they stay physically in `tests/corpus/`.** That is the home the T1
/// file plan gives them, and the fixture guards that check they still carry
/// their traps are attached there. `tests/conformance.rs` checks that this list
/// names every file of the directory: a list and a directory describing the
/// same set without ever meeting would drift apart, and the drift would take
/// the shape of a document added to the repository that the derivation would
/// never see.
///
/// They are offered to **every** grammar, with no regard for extension:
/// routing a document to a grammar by its name would hand the author of a
/// grammar the choice of what they are judged on.
///
/// **The list is enumerated by `build.rs`, never copied by hand** — the script
/// gives both reasons, one of which is scenario C7's ban on writing a host's
/// name into this source: enumerating the directory keeps that true whatever
/// name a document happens to carry, not only for the ones on disk today.
pub const SHARED_CORPUS: &[(&str, &str)] = generated::SHARED_CORPUS;

/// The list written by `build.rs` at compile time. It lives in its own module
/// so that the documentation of [`SHARED_CORPUS`] stays here, where it reads
/// together with the rest of the derivation.
mod generated {
    include!(concat!(env!("OUT_DIR"), "/shared_corpus.rs"));
}

/// The documents derived from `source` whose **refusal** the derivation
/// demands.
///
/// What each of them costs to counterfeit is the only reason they were chosen.
/// The first is prefixed with [`crate::NOT_A_DOCUMENT`]: it can be refused by a
/// `starts_with`, so on its own it proves nothing — it stays because a document
/// beginning with what is not one must be refused, and because it is the most
/// readable shape of the trial. The other two begin with the **same bytes as
/// the original**: refusing them requires reading at least as far as the point
/// where they stop being a document, that is, parsing. Concatenation with
/// itself uses no constant of this crate: it is recognisable by no pattern,
/// only by structure — two roots in JSON, a key or a table defined twice in
/// TOML.
pub fn mutations(source: &str) -> [(&'static str, String); 3] {
    [
        (
            "prefixed with what is not a document",
            format!("{}{source}", crate::NOT_A_DOCUMENT),
        ),
        (
            "followed by what is not a document",
            format!("{source}{}", crate::NOT_A_DOCUMENT),
        ),
        ("concatenated with itself", format!("{source}{source}")),
    ]
}

/// What the product allows itself to do with the documents of a grammar.
///
/// This term stays **declared**, like [`Resolution`]: what the product allows
/// itself to write is a decision, and no measurement replaces it. A library
/// that became faithful would not reopen a grammar the product has decided not
/// to write.
///
/// **What the declaration no longer buys, since T3b.** It grants nothing but
/// the right to be measured. A grammar declaring itself
/// [`GrammarRole::ReadWrite`] has its write path **executed** by
/// [`Capabilities::of`] — write, read back what was written, undo while
/// returning the pre-image byte for byte — and missing any one of the three
/// gets it refused, by name. That is the debt this module carried in writing
/// for as long as no grammar had a write path, and it is now collected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrammarRole {
    /// The product reads these documents and never writes into them. A product
    /// decision: the refusal is categorical and depends on no measurement —
    /// neither on a library, nor on a lost byte.
    ReadOnly,
    /// The product writes into these documents.
    ReadWrite,
}

/// How sensitive to order the resolution of a document is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// Order of appearance decides what wins. Writing a key at the wrong rank
    /// there is ineffective with no error and no trace.
    DependsOnOrder,
    /// Order plays no part in the resolution.
    IndependentOfOrder,
}

/// What diverged when the round trip failed to return the bytes. Measured,
/// never assumed: this is what the refusal names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriviaDivergence {
    first_divergent_offset: usize,
    crlf_in: usize,
    crlf_out: usize,
    bytes_in: usize,
    bytes_out: usize,
}

impl TriviaDivergence {
    /// What diverged between two renderings, or nothing if they are identical.
    ///
    /// Visible inside the crate because [`crate::merge`] measures on the user's
    /// document the same thing the derivation measures on the probe. A second
    /// way of saying "these bytes differ" would drift from this one, and the
    /// refusal would not name the same thing depending on where it fell from.
    pub(crate) fn measure(input: &str, output: &str) -> Option<Self> {
        if input == output {
            return None;
        }
        let (input, output) = (input.as_bytes(), output.as_bytes());
        let first_divergent_offset = input
            .iter()
            .zip(output.iter())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| input.len().min(output.len()));
        Some(Self {
            first_divergent_offset,
            crlf_in: input.iter().filter(|&&b| b == b'\r').count(),
            crlf_out: output.iter().filter(|&&b| b == b'\r').count(),
            bytes_in: input.len(),
            bytes_out: output.len(),
        })
    }
}

impl fmt::Display for TriviaDivergence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The wording is deduced from the measurement: name "the line endings"
        // when they are what went missing, and the offset alone when the loss
        // is elsewhere. A hand-written wording would survive a change of cause
        // by always pointing at the wrong one.
        if self.crlf_out < self.crlf_in {
            write!(
                f,
                "the line endings ({} CRLF in, {} out)",
                self.crlf_in, self.crlf_out
            )
        } else {
            write!(
                f,
                "the bytes from offset {} on (input {} bytes, output {})",
                self.first_divergent_offset, self.bytes_in, self.bytes_out
            )
        }
    }
}

/// Why the `merge` behaviour is refused on a grammar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefusalReason {
    /// The product does not write the documents of this grammar. A
    /// **categorical** reason: no measurement lifts it, least of all a library
    /// being fixed.
    ReadOnlyGrammar,
    /// The round trip on the probe did not return the bytes outside the trace.
    TriviaNotPreserved(TriviaDivergence),
    /// The resolution of the document depends on order of appearance.
    ResolutionDependsOnOrder,
    /// A document this grammar reads has no way of carrying a bounded block: of
    /// the wrappings a pose writes, not one leaves at once a block the
    /// recogniser finds again and a document the grammar still reads. Such a
    /// block would either have no bounds — invisible, hence unremovable — or
    /// have destroyed the document it was posed into, so the form "this block
    /// between these bounds" is unavailable, and it is the road a grammar
    /// refused for its order would otherwise have been left.
    NoDelimiterTheDocumentCanCarry {
        /// The document that can carry none, named: a grammar reads several,
        /// and one of them being unable to carry a block is what refuses the
        /// form. A refusal that did not name it would send its reader looking
        /// through all of them.
        document: &'static str,
    },
    /// Reading the probe itself failed: a grammar that cannot read back its own
    /// document can promise nothing about what it would write into one.
    ProbeUnreadable(crate::GrammarError),
    /// The probe does not carry the named dimension of hostile trivia, so
    /// preservation cannot be measured on it along that dimension: a round trip
    /// destroying it would pass for faithful.
    ProbeWithoutHostileTrivia {
        /// The missing dimension.
        dimension: &'static str,
    },
    /// The grammar accepted something that is not a document. There is
    /// therefore no parser behind its round trip, and an identity function
    /// would return any probe to the byte without having understood anything of
    /// the document.
    MalformedDocumentAccepted {
        /// The document whose mutation was accepted.
        document: &'static str,
        /// The accepted mutation, named — see [`mutations`].
        mutation: &'static str,
    },
    /// A document of the repository corpus that the grammar **reads** was not
    /// returned to the byte. This is the measurement its own probe cannot
    /// give: a probe carries only the trivia its author put in it.
    SharedCorpusNotPreserved {
        /// The repository document that was not returned.
        document: &'static str,
        /// What diverged, measured.
        divergence: TriviaDivergence,
    },
    /// The grammar reads no document of the repository corpus. Its preservation
    /// is therefore measured only on the probe it supplies itself, which leaves
    /// its author the choice of what they are judged on.
    NoSharedCorpusDocument,
    /// The fragment the probe declares as a comment is not one: the document
    /// stripped of that fragment is no longer readable, so the fragment carries
    /// data and the "comment" dimension is not measured.
    ProbeCommentIsNotTrivia(crate::GrammarError),
    /// The grammar declares itself writable and has no write path: its edit
    /// refuses. That is a capability announced without an implementation, and
    /// it is the debt this module had to collect the day a write path existed.
    NoWritePath(crate::GrammarError),
    /// The edit was applied but the rendering does not carry what it asked to
    /// write, or is no longer readable by its own grammar.
    EditNotApplied(&'static str),
    /// The inverse of the edit refused to apply: what the grammar wrote, it
    /// cannot undo.
    InverseUnusable(crate::GrammarError),
    /// The inverse applies but does not return the pre-image byte for byte:
    /// removal would reformat the owner's document, at the spot where nobody is
    /// looking.
    InverseNotByteIdentical(TriviaDivergence),
}

impl fmt::Display for RefusalReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReadOnlyGrammar => write!(
                f,
                "the product does not write the documents of this grammar — it is read-only by \
                 product decision, and that reason is lifted by no measurement"
            ),
            Self::TriviaNotPreserved(divergence) => write!(
                f,
                "the round trip does not return the bytes outside the trace: {divergence}"
            ),
            Self::ResolutionDependsOnOrder => write!(
                f,
                "the resolution of the document depends on order of appearance — writing by keys \
                 there would be ineffective with no error and no trace"
            ),
            Self::NoDelimiterTheDocumentCanCarry { document } => write!(
                f,
                "\"{document}\", a document this grammar reads, cannot carry a bounded block — of \
                 the four wrappings a pose writes its delimiters in, none leaves at once a block \
                 the recogniser finds again and a document this grammar still reads, so a block \
                 posed here would either have no bounds or destroy the document"
            ),
            Self::ProbeUnreadable(err) => {
                write!(f, "the probe of the grammar cannot be read back: {err}")
            }
            Self::ProbeWithoutHostileTrivia { dimension } => write!(
                f,
                "the probe of the grammar does not carry the \"{dimension}\" dimension — the \
                 preservation of the bytes outside the trace cannot be measured on it"
            ),
            Self::MalformedDocumentAccepted { document, mutation } => write!(
                f,
                "the grammar accepted \"{document}\" {mutation}, which is not a document — its \
                 round trip goes through no parser, and would return its probe to the byte \
                 without having understood any of it"
            ),
            Self::SharedCorpusNotPreserved {
                document,
                divergence,
            } => write!(
                f,
                "the round trip on \"{document}\", a repository document this grammar reads, \
                 does not return the bytes outside the trace: {divergence}"
            ),
            Self::NoSharedCorpusDocument => write!(
                f,
                "the grammar reads no document of the repository — its preservation is measured \
                 only on the probe it supplies itself"
            ),
            Self::ProbeCommentIsNotTrivia(err) => write!(
                f,
                "the fragment the probe declares to be a comment carries data: the document \
                 stripped of that fragment is no longer readable — {err}"
            ),
            Self::NoWritePath(err) => write!(
                f,
                "the grammar declares itself writable and has no write path — {err}"
            ),
            Self::EditNotApplied(detail) => {
                write!(f, "the edit was not applied to the probe: {detail}")
            }
            Self::InverseUnusable(err) => write!(
                f,
                "the inverse of the edit does not apply — what the grammar writes, it cannot \
                 undo: {err}"
            ),
            Self::InverseNotByteIdentical(divergence) => write!(
                f,
                "the inverse of the edit does not return the pre-image byte for byte: \
                 {divergence}"
            ),
        }
    }
}

/// The shape a `merge` takes in a document, of which there are two.
///
/// They are admitted **separately**, and that separation is the substance of
/// C7: a grammar whose reader is decided by position refuses the first and may
/// still take the second, and a document with nowhere to put a delimiter
/// refuses the second while the first stays open. Naming the form in a refusal
/// is what keeps two refusals of the same grammar from reading as one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeForm {
    /// "These keys at this path." What decides where the write lands is the
    /// path, so a document whose reader is decided by position decides it too.
    Keys,
    /// "This block between these bounds." What decides is a pair of delimiters
    /// the document has to be able to carry.
    BoundedBlock,
}

impl fmt::Display for MergeForm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Keys => write!(f, "these keys at this path"),
            Self::BoundedBlock => write!(f, "this block between these bounds"),
        }
    }
}

/// The refusal itself: it names the grammar, the form of the behaviour, and
/// every reason. Each reason is carried separately, because a refusal giving
/// only one of them suggests that lifting that one would be enough.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRefusal {
    grammar: &'static str,
    form: MergeForm,
    reasons: Vec<RefusalReason>,
}

impl MergeRefusal {
    /// The refused grammar.
    pub fn grammar(&self) -> &'static str {
        self.grammar
    }

    /// The form of the behaviour this refusal bears on. The other form has its
    /// own refusal, with its own reasons.
    pub fn form(&self) -> MergeForm {
        self.form
    }

    /// The reasons for the refusal, in the order they were observed.
    pub fn reasons(&self) -> &[RefusalReason] {
        &self.reasons
    }
}

impl fmt::Display for MergeRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the `merge` behaviour in the form \"{}\" is refused on grammar `{}`",
            self.form, self.grammar
        )?;
        for reason in &self.reasons {
            write!(f, " ; {reason}")?;
        }
        Ok(())
    }
}

/// The admission of a grammar to the `merge` behaviour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeAdmission {
    /// The grammar is admitted.
    Admitted,
    /// The grammar is refused, by name.
    Refused(MergeRefusal),
}

/// What a grammar can express.
///
/// The fields are private and [`Capabilities::of`] is the only path that builds
/// one. This is not a stylistic precaution: it is the guarantee that no
/// capability can be **announced** anywhere other than where it is **executed**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    grammar: &'static str,
    role: GrammarRole,
    trivia: Vec<RefusalReason>,
    shared_corpus_documents_read: usize,
    designates_list_element: bool,
    applies_edits: bool,
    resolution: Resolution,
    delimiter_wrappings: Vec<Wrapping>,
    merge_by_keys: MergeAdmission,
    merge_bounded_block: MergeAdmission,
}

impl Capabilities {
    /// Measures the capabilities of `G` by running its properties on its probe.
    pub fn of<G: Grammar>() -> Self {
        let probe = G::PROBE;

        let TriviaMeasure {
            reasons: trivia,
            shared_corpus_documents_read,
        } = measure_trivia::<G>();

        // Designating a list element means finding the one that is there and
        // not finding the one that is not. An implementation that answers
        // without looking at the document fails on the second half.
        let designates_list_element = matches!(
            G::find_string_in_list(probe.source, probe.list_path, probe.value_present),
            Ok(true)
        ) && matches!(
            G::find_string_in_list(probe.source, probe.list_path, probe.value_absent),
            Ok(false)
        );

        // Reasons are accumulated from the most categorical to the most
        // contingent, and all of them are carried: a refusal giving only one
        // suggests that lifting that one would be enough. Read-only therefore
        // comes first — it is lifted by no measurement.
        //
        // The write path is measured only on a grammar that declares itself
        // writable. On a read-only grammar, the absence of a write path is not
        // a defect but the decision itself, and publishing it as a second
        // motive would suggest that writing one would reopen the gate.
        let write = if G::ROLE == GrammarRole::ReadWrite {
            measure_write_path::<G>()
        } else {
            Vec::new()
        };
        let applies_edits = G::ROLE == GrammarRole::ReadWrite && write.is_empty();

        let mut by_keys = Vec::new();
        if G::ROLE == GrammarRole::ReadOnly {
            by_keys.push(RefusalReason::ReadOnlyGrammar);
        }
        by_keys.extend(trivia.iter().cloned());
        by_keys.extend(write);
        if G::RESOLUTION == Resolution::DependsOnOrder {
            by_keys.push(RefusalReason::ResolutionDependsOnOrder);
        }

        // The second form answers to its own reasons, and the difference is not
        // an omission. Order departs the keys and not the bounds: a block is
        // designated by its delimiters, and no position arbitrates it. The
        // write path of the grammar departs neither: a block is written on the
        // lines of the document and never rendered by a parser, which is why
        // `marker` goes through no `Grammar`. What is left is the decision not
        // to write these documents at all — categorical, and it holds for any
        // form — and whether the documents can carry a block.
        let delimiters = measure_delimiters::<G>();
        let mut bounded_block = Vec::new();
        if G::ROLE == GrammarRole::ReadOnly {
            bounded_block.push(RefusalReason::ReadOnlyGrammar);
        }
        bounded_block.extend(delimiters.reasons);

        Self {
            grammar: G::NAME,
            role: G::ROLE,
            trivia,
            shared_corpus_documents_read,
            designates_list_element,
            applies_edits,
            resolution: G::RESOLUTION,
            delimiter_wrappings: delimiters.wrappings,
            merge_by_keys: admission::<G>(MergeForm::Keys, by_keys),
            merge_bounded_block: admission::<G>(MergeForm::BoundedBlock, bounded_block),
        }
    }

    /// The name of the measured grammar.
    pub fn grammar(&self) -> &'static str {
        self.grammar
    }

    /// What the product allows itself to do with its documents.
    pub fn role(&self) -> GrammarRole {
        self.role
    }

    /// Whether the grammar returns the bytes outside the trace unchanged.
    pub fn preserves_trivia(&self) -> bool {
        self.trivia.is_empty()
    }

    /// How many documents of [`SHARED_CORPUS`] this grammar reads.
    ///
    /// Zero means its preservation was measured only on the probe it supplies
    /// itself — that is a defect of the instrument, and it is carried as such
    /// by [`RefusalReason::NoSharedCorpusDocument`].
    pub fn shared_corpus_documents_read(&self) -> usize {
        self.shared_corpus_documents_read
    }

    /// Whether the grammar can designate a list element by its value.
    pub fn designates_list_element(&self) -> bool {
        self.designates_list_element
    }

    /// Whether the grammar can write an edit **and undo it** while returning
    /// the pre-image byte for byte. Measured by running both on its probe,
    /// never deduced from its declared role.
    pub fn applies_edits(&self) -> bool {
        self.applies_edits
    }

    /// How sensitive to order the resolution of its documents is.
    pub fn resolution(&self) -> Resolution {
        self.resolution
    }

    /// The wrappings under which a block can be posed into **every** document
    /// this grammar reads. Measured by posing one — see [`measure_delimiters`].
    ///
    /// **Why a set and not a verdict.** The four wrappings are not carried
    /// alike by the same document, and a caller has to choose one before it
    /// poses anything. Publishing "at least one works" hands it a yes that
    /// names no road, and the road it then takes may be the one the trial
    /// measured as destroying the file.
    pub fn delimiter_wrappings(&self) -> &[Wrapping] {
        &self.delimiter_wrappings
    }

    /// Whether the documents of this grammar can carry a bounded block at all,
    /// that is, whether [`Capabilities::delimiter_wrappings`] is not empty. It
    /// is derived from the set and never measured on its own: a verdict
    /// computed apart from the list it summarises would sooner or later
    /// disagree with it.
    pub fn carries_delimiters(&self) -> bool {
        !self.delimiter_wrappings.is_empty()
    }

    /// Admission to `merge` in the form "these keys at this path", and its
    /// named refusal where applicable.
    pub fn merge_by_keys(&self) -> &MergeAdmission {
        &self.merge_by_keys
    }

    /// Admission to `merge` in the form "this block between these bounds", and
    /// its named refusal where applicable.
    ///
    /// It is asked **separately** from [`Capabilities::merge_by_keys`] and
    /// answers to its own reasons: a caller reading only one of the two would
    /// take a road that is open for a road that is not, or the reverse.
    pub fn merge_bounded_block(&self) -> &MergeAdmission {
        &self.merge_bounded_block
    }
}

/// Turns the reasons gathered for one form into its admission. Written once:
/// two forms building their verdict each in their own way would sooner or later
/// disagree about what an empty list of reasons means.
fn admission<G: Grammar>(form: MergeForm, reasons: Vec<RefusalReason>) -> MergeAdmission {
    if reasons.is_empty() {
        MergeAdmission::Admitted
    } else {
        MergeAdmission::Refused(MergeRefusal {
            grammar: G::NAME,
            form,
            reasons,
        })
    }
}

/// The body the delimiter trial poses between the bounds.
///
/// **A block with nothing between its bounds is the one shape a pose never
/// writes**, and measuring on it is what credited the grammar of a strict
/// settings document with carrying a block: its two delimiters can be two
/// comments the parser of this crate tolerates, while the first line put
/// between them is a value of no language and the file its owner opens stops
/// being read at all. What a pose writes there is the text a catalogue
/// publishes — lines of prose, which are not values of the document's grammar —
/// so that is what the trial writes.
const TRIAL_BODY: &[&str] = &["a line a catalogue would pose"];

/// What the delimiter measurement reports: the wrappings every document the
/// grammar reads can carry a block under, and the reason it can carry none.
struct DelimiterMeasure {
    wrappings: Vec<Wrapping>,
    reasons: Vec<RefusalReason>,
}

/// Measures under which wrappings a document of `G` is able to **carry** a
/// bounded block, by posing one into it.
///
/// **The trial poses; it does not imitate a pose.** It calls [`marker::place`],
/// the very function a pose runs, with the body a pose writes. A rendering
/// built here for the trial would drift from the one production writes, and the
/// drift has already been paid: two bare delimiters with nothing between them
/// pass through a JSON parser where the block a pose actually writes does not,
/// so a strict settings document was credited with carrying what would make its
/// host stop reading it.
///
/// **Both conditions, because neither alone is the capacity.** A block the
/// recogniser does not find again delimits nothing: it is invisible, hence
/// unremovable, and every further pose appends another copy — that half is
/// [`marker::place`]'s own post-condition, and it is why the trial reads its
/// verdict rather than its own. A block that breaks the document has destroyed
/// what it was posed into — that half is `G::round_trip` on the rendering, and
/// no other code in this crate can answer it.
///
/// **Every wrapping, and the set is kept.** A pose writes four, and the one
/// that suits the documents served today would be a rule by name in another
/// alphabet: it would go on answering "yes" the day a document changes format,
/// with nothing going red. Each of the four is posed, and what is published is
/// those that survived — not a fold of them into a single yes.
///
/// **Every document the grammar reads, and the answer is their intersection.**
/// The capacity belongs to the document, the table has a line per grammar, and
/// a caller reads that line before posing into a document the table cannot name
/// for it. The only wrapping it can be handed safely is therefore one that
/// carried in **all** of them; a document that carries none refuses the form and
/// is named in the refusal.
///
/// **What it does not establish.** The rendering is judged by `G::round_trip`,
/// which is the parser of this product and not the program that reads the
/// document. A grammar accepting more than that program credits its documents
/// with more than they carry; what keeps that from being free is that the same
/// permissiveness is measured, published and refused for the other form, on the
/// same line of the table.
fn measure_delimiters<G: Grammar>() -> DelimiterMeasure {
    let probe = G::PROBE.source;
    if let Err(err) = G::round_trip(probe) {
        // A grammar that cannot read its own probe renders nothing to judge,
        // and naming the document here would report a property of the document
        // where the defect is in the instrument.
        return DelimiterMeasure {
            wrappings: Vec::new(),
            reasons: vec![RefusalReason::ProbeUnreadable(err)],
        };
    }

    let mut reasons = Vec::new();
    let mut carried: Option<Vec<Wrapping>> = None;
    let documents = std::iter::once(("the probe", probe)).chain(SHARED_CORPUS.iter().copied());

    for (document, source) in documents {
        // A refused document is not a defect: a grammar does not read the
        // documents of another, and what it does not read it cannot be asked to
        // carry anything in.
        if G::round_trip(source).is_err() {
            continue;
        }
        let here = wrappings_posed::<G>(document, source);
        if here.is_empty() {
            reasons.push(RefusalReason::NoDelimiterTheDocumentCanCarry { document });
        }
        carried = Some(match carried {
            None => here,
            Some(kept) => kept.into_iter().filter(|w| here.contains(w)).collect(),
        });
    }

    DelimiterMeasure {
        wrappings: carried.unwrap_or_default(),
        reasons,
    }
}

/// The wrappings under which a block can be posed into `source` and leave a
/// document `G` still reads.
fn wrappings_posed<G: Grammar>(document: &'static str, source: &str) -> Vec<Wrapping> {
    // The identity names the trial, and nothing of a catalogue: what is
    // measured here is the document's ability to carry a block, which does not
    // depend on whose block it is.
    let marker = Marker::new("capability-derivation", "delimiter-trial");

    Wrapping::ALL
        .iter()
        .copied()
        .filter(|&wrapping| {
            let pose = Pose {
                marker: &marker,
                address: document,
                roots: &[],
                traced: &[],
                posed: None,
                body: TRIAL_BODY,
                wrapping,
            };
            marker::place(source, &pose).is_ok_and(|placed| G::round_trip(&placed.rendered).is_ok())
        })
        .collect()
}

/// What the trivia measurement reports: the reasons to refuse, all of them, and
/// the number of repository documents the grammar read.
///
/// **All the reasons, not the first one.** The trials no longer stop at the
/// first failure, and that is not a reporting convenience: the count of
/// repository documents read must be established even when the probe has
/// already failed, failing which a grammar refused on its probe would pass for
/// a grammar that reads nothing of the repository, and the two defects of
/// instrument would become indistinguishable.
struct TriviaMeasure {
    reasons: Vec<RefusalReason>,
    shared_corpus_documents_read: usize,
}

/// Measures the trivia preservation of `G`, in trials that run from the
/// instrument towards the measurement, and on two sets of documents of which
/// only one belongs to the grammar being judged.
///
/// **The instrument trials** exist because both the probe and the round trip
/// are supplied by the grammar being judged. A watered-down probe, or an
/// implementation returning its input unchanged, would make the answer
/// trivially true. They do not make a lying announcement impossible — see the
/// module header — they make it measurably false on what is measurable.
///
/// **The trials on [`SHARED_CORPUS`]** bear on documents the author of a
/// grammar does not choose. This is the only part of the measurement whose
/// instrument they do not supply, and that is why it catches what the probe
/// lets through: a form of trivia the probe does not contain, and a
/// counterfeit refusal that never had to read a real document.
fn measure_trivia<G: Grammar>() -> TriviaMeasure {
    let probe = G::PROBE;
    let mut reasons = Vec::new();

    // 1. The instrument carries the three dimensions of hostile trivia. The
    //    first two can be recognised without knowing anything about the
    //    grammar; the third is declared, and checked in 3. These three
    //    dimensions name categories and not shapes — a block comment absent
    //    from the probe stays invisible here, and it is trial 5 that catches
    //    it.
    for (dimension, present) in [
        ("CRLF line ending", probe.source.contains("\r\n")),
        (
            "indented line",
            probe
                .source
                .lines()
                .any(|line| line.starts_with(' ') || line.starts_with('\t')),
        ),
        (
            "comment",
            !probe.comment.is_empty() && probe.source.contains(probe.comment),
        ),
    ] {
        if !present {
            reasons.push(RefusalReason::ProbeWithoutHostileTrivia { dimension });
        }
    }

    // 2. A parser exists. What tells a grammar apart from an identity function
    //    is not what it returns, it is what it **refuses**: an identity returns
    //    any probe to the byte and would be credited with everything. The
    //    refusal is therefore a condition of the measurement, not a separate
    //    property.
    //
    //    A consequence accepted and written here rather than discovered later:
    //    a grammar whose language accepts **any text** fails this trial and is
    //    not admitted. That is the right sense of the refusal — its
    //    preservation cannot be measured by a round trip, it will be measured
    //    on its write path, and admission will then reopen with a motive
    //    instead of having been granted by default.
    reasons.extend(refused_mutations::<G>("the probe", probe.source));

    // 3. The fragment declared to be a comment is one. Removed, the document
    //    must stay readable — otherwise it carried data, and the "comment"
    //    dimension was carried by the declaration alone.
    if !probe.comment.is_empty() {
        if let Err(err) = G::round_trip(&probe.source.replace(probe.comment, "")) {
            reasons.push(RefusalReason::ProbeCommentIsNotTrivia(err));
        }
    }

    // 4. The measurement on the probe: it is read back, and the bytes returned
    //    are compared to the bytes fed in.
    match G::round_trip(probe.source) {
        Err(err) => reasons.push(RefusalReason::ProbeUnreadable(err)),
        Ok(rendered) => {
            if let Some(divergence) = TriviaDivergence::measure(probe.source, &rendered) {
                reasons.push(RefusalReason::TriviaNotPreserved(divergence));
            }
        }
    }

    // 5. The measurement on the repository corpus. Every document is offered,
    //    and a refused document is not a defect: a grammar does not read the
    //    documents of another. What is demanded bears on those it **accepts** —
    //    returning them to the byte, and refusing their mutations.
    let mut shared_corpus_documents_read = 0;
    for &(document, source) in SHARED_CORPUS {
        let Ok(rendered) = G::round_trip(source) else {
            continue;
        };
        shared_corpus_documents_read += 1;
        if let Some(divergence) = TriviaDivergence::measure(source, &rendered) {
            reasons.push(RefusalReason::SharedCorpusNotPreserved {
                document,
                divergence,
            });
        }
        reasons.extend(refused_mutations::<G>(document, source));
    }
    if shared_corpus_documents_read == 0 {
        reasons.push(RefusalReason::NoSharedCorpusDocument);
    }

    TriviaMeasure {
        reasons,
        shared_corpus_documents_read,
    }
}

/// Measures the write path of `G` by **running** it on its probe: a value the
/// probe declares absent is written there, then removed by the inverse the edit
/// returned.
///
/// **What this measurement closes.** The role of a grammar is a product
/// decision, hence declared; for as long as no grammar had a write path,
/// declaring oneself writable cost nothing and nothing could contradict it.
/// That is the debt this module carried in writing. A grammar declaring itself
/// writable must now **write**, **read back what it wrote**, and **return the
/// pre-image byte for byte** when undoing it.
///
/// **What it does not close.** The probe belongs to the grammar being judged,
/// so a trivial edit on a docile document remains possible here. It is
/// `tests/conformance.rs` that exercises the same property on the documents of
/// the repository, which the author of a grammar does not choose.
///
/// **And what neither of the two could close.** One single edit is written
/// here, and one single edit there: what they establish is that a write path
/// exists and that it undoes itself **on that case**. Nothing follows for the
/// next write, on a document nobody has seen — a key whose value carries a
/// comment is replaced without error and does not undo. Admission therefore
/// cannot be the last word: [`crate::merge`] undoes every write it computes
/// before returning it, and refuses if the bytes from before do not come back.
fn measure_write_path<G: Grammar>() -> Vec<RefusalReason> {
    let probe = G::PROBE;
    let edit = crate::Edit::values(probe.list_path, [probe.value_absent]);

    let applied = match G::apply(probe.source, &edit) {
        Ok(applied) => applied,
        Err(err) => return vec![RefusalReason::NoWritePath(err)],
    };

    // Reading back goes through the enumeration of values, and not through the
    // search in a list: the enumeration is the witness the post-condition uses,
    // so it is the one that must exist. A grammar that writes without being
    // able to read back what it wrote can promise nothing about what it
    // destroyed.
    let mut reasons = Vec::new();
    let written = crate::SemanticValue::new(
        probe.list_path.join("."),
        crate::Value::Text(probe.value_absent.to_string()),
    );
    match G::values(&applied.rendered) {
        Err(_) => reasons.push(RefusalReason::EditNotApplied(
            "the rendering is no longer readable by its own grammar",
        )),
        Ok(values) => {
            if !values.contains(&written) {
                reasons.push(RefusalReason::EditNotApplied(
                    "the written value is absent from the rendering",
                ));
            }
        }
    }

    match G::invert(&applied.rendered, &applied.inverse) {
        Err(err) => reasons.push(RefusalReason::InverseUnusable(err)),
        Ok(undone) => {
            if let Some(divergence) = TriviaDivergence::measure(probe.source, &undone) {
                reasons.push(RefusalReason::InverseNotByteIdentical(divergence));
            }
        }
    }

    reasons
}

/// Demands of `G` that it refuse every mutation of `source`, and names those it
/// accepted.
fn refused_mutations<G: Grammar>(document: &'static str, source: &str) -> Vec<RefusalReason> {
    mutations(source)
        .into_iter()
        .filter(|(_, mutant)| G::round_trip(mutant).is_ok())
        .map(|(mutation, _)| RefusalReason::MalformedDocumentAccepted { document, mutation })
        .collect()
}

/// The capability table of the grammars this crate carries today.
///
/// It will carry others — the block bounded by markers, and the header read —
/// and each will be added here by one call line, its measurement coming from
/// its implementation.
pub fn table() -> Vec<Capabilities> {
    vec![Capabilities::of::<Jsonc>(), Capabilities::of::<Toml>()]
}
