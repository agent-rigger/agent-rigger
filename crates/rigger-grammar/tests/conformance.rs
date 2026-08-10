//! The properties **every** grammar passes. Adding a grammar is one call line;
//! adding a document is a file dropped into one of the two corpus directories.
//!
//! **Byte-identical round trip** (T1): for every document of `tests/corpus/`,
//! `parse` then `render` with no edit at all, and the output byte must be
//! identical to the input byte. The comparison bears on `Vec<u8>`, never on
//! normalised `String`s, so as not to hide a line ending converted from CRLF to
//! LF.
//!
//! **Named refusal on a malformed document** (T3a): for every document of
//! **both** directories, a version made unreadable must get the grammar to
//! refuse while naming itself.
//!
//! **`apply` then `invert` byte-identical to the pre-image** (T3b): on every
//! document a grammar **admitted** to `merge` can read, an edit is written then
//! undone, and the bytes from before must come back. The same property checks
//! that what the edit changes is a **contiguous** fragment, that is, that the
//! document was not re-emitted whole.
//!
//! **The inverse still applies after its owner reindents the document**: the
//! same edit is written, the **owner** then reindents what came out, and
//! undoing must give his document back as he reindented it. This is the
//! property that separates a trace addressed by the structure of the grammar
//! from one addressed by position, and the one above cannot separate them: it
//! hands `invert` the very bytes `apply` produced, so a recorded offset, line
//! number or span passes it intact.
//!
//! **Every property accounts for every document it is given.** A property that
//! cannot bear on a document files it as out of scope **with its reason** — see
//! [`OutOfScope`] and [`Scope`] — and a run that files a document under
//! neither goes red. What that buys is the difference between "looked at it and
//! found nothing" and "never looked at it", which this crate treats as an
//! inverted meaning rather than an imprecision of display: it is the same
//! inversion as a removal reporting success on a thing it never found.
//!
//! **What that property does not exercise, and where it is held.** The edit
//! used writes a key that no document of the corpus carries, so it only takes
//! the **add** branch; the **replace** branch is not exercised here, and cannot
//! be without choosing a key document by document. It is
//! [`rigger_grammar::merge`] that holds the property where it decides
//! something: it undoes the write it has just computed and refuses if the bytes
//! from before do not come back — on the user's document, whichever branch was
//! taken. This file measures what a grammar can do; `merge` measures what it
//! has just done.
//!
//! `tests/corpus/` carries the documents whose trivia the grammar preserves;
//! `tests/corpus-limits/` carries those whose trivia it does not, and the
//! second is wired here to what the capability table says about it — a document
//! exercised by no property would stay tested for one single property, forever.
//!
//! T1 requires that **no byte of the corpus be copied from a real file on the
//! machine** — this repository is public, and a configuration lifted from a
//! workstation would be published with it. The properties tested never read a
//! value, so the neutrality of the content costs the measurement nothing.
//!
//! This file also carries a fixture guard
//! (`guard_the_corpus_still_carries_its_traps`, right at the bottom): it checks
//! that the corpus still carries its traps, not that the grammar preserves
//! them. The two tests are deliberately distinct, never mixed into one
//! assertion.
//!
//! The measured limit of `toml_edit` on CRLF line endings is not here: it is
//! recorded as a characterization test in `tests/known_limits.rs`, which bears
//! on the **library**, where this file bears on the crate.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use rigger_grammar::{
    Applied, Capabilities, Edit, Grammar, GrammarError, Inverse, Jsonc, MergeAdmission,
    MergeRefusal, Toml, Value,
};

/// The prefix that makes a document unreadable in both grammars. It comes from
/// the crate — `rigger_grammar::NOT_A_DOCUMENT` — because the capability
/// derivation uses it as proof that a parser exists: two definitions would
/// drift apart, and the property checked here would no longer be the one the
/// table demands over there.
const MALFORMED_PREFIX: &str = rigger_grammar::NOT_A_DOCUMENT;

/// The grammar of a corpus document, deduced from its extension. This is the
/// only routing: the properties below know nothing but this type.
#[derive(Clone, Copy, Debug)]
enum CorpusGrammar {
    Jsonc,
    Toml,
}

impl CorpusGrammar {
    /// The grammars this file can route to. Written by hand, as `table()` is on
    /// the other side — and that is why
    /// `guard_every_published_grammar_is_exercised_on_the_corpus` compares the
    /// two: two lists describing the same set without ever meeting drift apart,
    /// and the drift takes the shape of a published grammar, "measured", that
    /// the corpus has never crossed.
    const ALL: [Self; 2] = [Self::Jsonc, Self::Toml];

    fn of(path: &Path) -> Result<Self, String> {
        match path.extension().and_then(|ext| ext.to_str()) {
            Some("json") => Ok(Self::Jsonc),
            Some("toml") => Ok(Self::Toml),
            other => Err(format!(
                "{}: unrecognised corpus extension ({:?}) — no grammar can serve it",
                path.display(),
                other
            )),
        }
    }

    fn round_trip(self, source: &str) -> Result<String, GrammarError> {
        match self {
            Self::Jsonc => Jsonc::round_trip(source),
            Self::Toml => Toml::round_trip(source),
        }
    }

    fn capabilities(self) -> Capabilities {
        match self {
            Self::Jsonc => Capabilities::of::<Jsonc>(),
            Self::Toml => Capabilities::of::<Toml>(),
        }
    }

    fn apply(self, source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        match self {
            Self::Jsonc => Jsonc::apply(source, edit),
            Self::Toml => Toml::apply(source, edit),
        }
    }

    fn invert(self, source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        match self {
            Self::Jsonc => Jsonc::invert(source, inverse),
            Self::Toml => Toml::invert(source, inverse),
        }
    }
}

/// Compares two byte buffers and, on divergence, returns a message naming the
/// file and the offset of the first divergent byte — never a bare "not equal"
/// that does not say where to look.
fn compare_byte_identical(path: &Path, input: &[u8], output: &[u8]) -> Result<(), String> {
    if input == output {
        return Ok(());
    }
    let mismatch_at = input
        .iter()
        .zip(output.iter())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| input.len().min(output.len()));
    let context = |buf: &[u8], at: usize| -> String {
        let end = (at + 24).min(buf.len());
        String::from_utf8_lossy(&buf[at..end]).into_owned()
    };
    Err(format!(
        "{}: round trip not byte-identical — first divergent byte at offset {} \
         (input {} bytes, output {} bytes)\n  input  from that offset: {:?}\n  output from that offset: {:?}",
        path.display(),
        mismatch_at,
        input.len(),
        output.len(),
        context(input, mismatch_at),
        context(output, mismatch_at),
    ))
}

fn read_utf8(path: &Path) -> Result<(Vec<u8>, String), String> {
    let input = fs::read(path).map_err(|err| format!("{}: cannot read — {err}", path.display()))?;
    let text = std::str::from_utf8(&input)
        .map_err(|err| format!("{}: the corpus must be UTF-8 — {err}", path.display()))?
        .to_string();
    Ok((input, text))
}

fn check_round_trip(path: &Path) -> Result<(), String> {
    let grammar = CorpusGrammar::of(path)?;
    let (input, text) = read_utf8(path)?;
    let output = grammar
        .round_trip(&text)
        .map_err(|err| format!("{}: {err}", path.display()))?;
    compare_byte_identical(path, &input, output.as_bytes())
}

/// Why a conformance property has **no object** on a corpus document.
///
/// A property that cannot bear on a document has to produce a named finding.
/// The alternative is a bare `continue`, whose report cannot be told apart from
/// a check that ran and found nothing — the same inversion of meaning as a
/// removal reporting success on a thing it never found.
///
/// Neither variant can be written by hand where a document is passed over: one
/// is built from the corpus directory the document was put into, the other from
/// the refusal the capability table publishes. A sentence typed next to a
/// `continue` keeps reading true long after the reason it names has changed; a
/// reason carried out of the place the decision is taken cannot.
#[derive(Debug)]
enum OutOfScope {
    /// The grammar does not return the bytes of this document, which is the
    /// single reason a document is kept in the limits corpus. A property
    /// demanding byte identity has nothing to establish on it; the opposite
    /// direction is what `guard_the_limits_corpus_agrees_with_the_capability_table`
    /// establishes, against the capability table rather than a hand-kept list.
    GrammarDoesNotReturnItsBytes {
        /// The grammar that reads the document, named — a report saying only
        /// "out of scope" sends its reader looking.
        grammar: &'static str,
    },
    /// The capability table refuses this grammar the `merge` behaviour. A
    /// grammar the product has decided not to write has no `apply` at all, so a
    /// property bearing on what `apply` produces has literally no object on any
    /// of its documents: passing them over is right, keeping quiet about it is
    /// not. The refusal is carried whole — it names the grammar, the form of the
    /// behaviour, and every reason, the categorical one included.
    MergeRefused(MergeRefusal),
}

impl fmt::Display for OutOfScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GrammarDoesNotReturnItsBytes { grammar } => write!(
                f,
                "grammar `{grammar}` does not return the bytes of this document — that is why it \
                 is kept out of the preserved corpus, and byte identity is not what is asked of it"
            ),
            Self::MergeRefused(refusal) => write!(f, "{refusal}"),
        }
    }
}

/// A corpus document a property bears on, read once and carried whole so that
/// the property does not read it a second time under another name.
struct Document {
    path: PathBuf,
    grammar: CorpusGrammar,
    bytes: Vec<u8>,
    text: String,
}

/// The accounting of one conformance property over the documents it was given:
/// what it bore on, what it had no object on and why, and what failed.
///
/// [`Scope::conclude`] is what makes that accounting mechanical instead of a
/// matter of care — it refuses to end unless every document handed to the
/// property was filed as one or the other. A `continue` added later that files
/// nothing turns the property red rather than shrinking it in silence, which is
/// the failure this file was carrying: a corpus document wired to one property
/// out of four, and nothing anywhere saying so.
struct Scope {
    property: &'static str,
    borne: Vec<PathBuf>,
    out_of_scope: Vec<(PathBuf, OutOfScope)>,
    failures: Vec<String>,
}

impl Scope {
    fn new(property: &'static str) -> Self {
        Self {
            property,
            borne: Vec::new(),
            out_of_scope: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// The property bore on this document — whatever it then concluded.
    fn borne(&mut self, path: &Path) {
        self.borne.push(path.to_path_buf());
    }

    /// The property has no object on this document, for this reason.
    fn out_of_scope(&mut self, path: &Path, reason: OutOfScope) {
        self.out_of_scope.push((path.to_path_buf(), reason));
    }

    fn fail(&mut self, message: String) {
        self.failures.push(message);
    }

    /// What was passed over, one line per document, reasons included. It is
    /// printed with every failure of the property: a reader looking at a red run
    /// has to be able to see what was **not** measured, which is exactly the
    /// information a bare `continue` withholds.
    fn out_of_scope_report(&self) -> String {
        if self.out_of_scope.is_empty() {
            return "  (none)".to_string();
        }
        self.out_of_scope
            .iter()
            .map(|(path, reason)| format!("  {} — {reason}", path.display()))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Ends the property: every document accounted for, at least one borne, no
    /// failure.
    fn conclude(self, documents: &[PathBuf]) {
        assert!(
            self.failures.is_empty(),
            "{}: {} failure(s):\n\n{}\n\ndocuments this property had no object on:\n{}",
            self.property,
            self.failures.len(),
            self.failures.join("\n\n"),
            self.out_of_scope_report()
        );

        let unaccounted: Vec<String> = documents
            .iter()
            .filter(|path| {
                !self.borne.contains(path)
                    && !self.out_of_scope.iter().any(|(filed, _)| filed == *path)
            })
            .map(|path| format!("  {}", path.display()))
            .collect();
        assert!(
            unaccounted.is_empty(),
            "{}: {} document(s) neither borne nor named out of scope — they were passed over in \
             silence, which reads from the report exactly like a check that found nothing:\n{}",
            self.property,
            unaccounted.len(),
            unaccounted.join("\n")
        );

        assert!(
            !self.borne.is_empty(),
            "{}: the property bore on no document at all — it would establish nothing while \
             reporting green. Documents it had no object on:\n{}",
            self.property,
            self.out_of_scope_report()
        );
    }
}

/// The documents a property about **writing** can bear on, filed as it goes.
///
/// A document whose grammar the capability table refuses the `merge` behaviour
/// is put out of scope carrying that refusal — never dropped, and never with a
/// reason invented here. A document that cannot be routed or cannot be read is a
/// **failure** and not a skip: the property is silent about it in neither
/// direction.
fn documents_admitted_to_merge(documents: &[PathBuf], scope: &mut Scope) -> Vec<Document> {
    let mut admitted = Vec::new();
    for path in documents {
        let grammar = match CorpusGrammar::of(path) {
            Ok(grammar) => grammar,
            Err(message) => {
                scope.borne(path);
                scope.fail(message);
                continue;
            }
        };
        match grammar.capabilities().merge_by_keys() {
            MergeAdmission::Refused(refusal) => {
                scope.out_of_scope(path, OutOfScope::MergeRefused(refusal.clone()));
            }
            MergeAdmission::Admitted => {
                scope.borne(path);
                match read_utf8(path) {
                    Err(message) => scope.fail(message),
                    Ok((bytes, text)) => admitted.push(Document {
                        path: path.clone(),
                        grammar,
                        bytes,
                        text,
                    }),
                }
            }
        }
    }
    admitted
}

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

fn limits_corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus-limits")
}

fn documents_in(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("{}: corpus directory not found — {err}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    entries.sort();
    entries
}

fn corpus_entries() -> Vec<PathBuf> {
    documents_in(&corpus_dir())
}

/// Every document, both directories taken together. This is the enumeration
/// taken by the properties that do not depend on trivia preservation.
fn all_documents() -> Vec<PathBuf> {
    let mut documents = corpus_entries();
    documents.extend(documents_in(&limits_corpus_dir()));
    documents
}

#[test]
fn c1_a_round_trip_without_edit_is_byte_identical() {
    let entries = corpus_entries();

    // One single statement of the corpus size invariant: three known
    // documents, and the number of entries read cannot structurally depart from
    // it since every entry is either checked or named as a failure below — no
    // third, redundant formulation.
    assert_eq!(
        entries.len(),
        3,
        "the expected corpus holds three documents (commented.json, settings.json, config.toml), {} found in {}",
        entries.len(),
        corpus_dir().display()
    );

    // The property is offered **every** document of the repository, the limits
    // corpus included, and names the ones it has no object on instead of
    // iterating a list that quietly excludes them. Byte identity is not what is
    // asked of a document kept there — that is the definition of the place — but
    // "not asked" has to be said, or the report reads as though the whole
    // repository had been returned to the byte.
    //
    // Every document is checked even if an earlier one failed: one failure must
    // not hide the following ones in the run report.
    let documents = all_documents();
    let mut scope = Scope::new("a round trip with no edit returns the bytes");
    for path in &documents {
        if path.starts_with(corpus_dir()) {
            scope.borne(path);
            if let Err(message) = check_round_trip(path) {
                scope.fail(message);
            }
            continue;
        }
        match CorpusGrammar::of(path) {
            Ok(grammar) => scope.out_of_scope(
                path,
                OutOfScope::GrammarDoesNotReturnItsBytes {
                    grammar: grammar.capabilities().grammar(),
                },
            ),
            Err(message) => {
                scope.borne(path);
                scope.fail(message);
            }
        }
    }
    scope.conclude(&documents);
}

/// Second common property: a document the grammar cannot read produces a
/// refusal that **names it**. It bears on both directories, which is the only
/// wiring by which `corpus-limits/` is exercised by a conformance property and
/// not by its characterization test alone.
#[test]
fn guard_a_malformed_document_is_refused_by_a_grammar_that_names_itself() {
    let documents = all_documents();
    assert!(
        documents.len() > corpus_entries().len(),
        "no document in {} — the property would bear on the admitted corpus only",
        limits_corpus_dir().display()
    );

    let failures: Vec<String> = documents
        .iter()
        .filter_map(|path| {
            let grammar = CorpusGrammar::of(path).ok()?;
            let (_, text) = read_utf8(path).ok()?;
            let malformed = format!("{MALFORMED_PREFIX}{text}");
            match grammar.round_trip(&malformed) {
                Ok(_) => Some(format!(
                    "{}: malformed document accepted by grammar `{}`",
                    path.display(),
                    grammar.capabilities().grammar()
                )),
                Err(err) => {
                    let name = grammar.capabilities().grammar();
                    let message = err.to_string();
                    if err.grammar() == name && message.contains(name) {
                        None
                    } else {
                        Some(format!(
                            "{}: the refusal does not name grammar `{name}` — {message}",
                            path.display()
                        ))
                    }
                }
            }
        })
        .collect();

    if !failures.is_empty() {
        panic!(
            "{} document(s) whose refusal is not named:\n\n{}",
            failures.len(),
            failures.join("\n\n")
        );
    }
}

/// Third common property (T3b): on a document the grammar reads and is
/// **admitted** to write, `apply` then `invert` returns the pre-image byte for
/// byte, and what `apply` changes is limited to a contiguous fragment.
///
/// **Why this property is here and not in the derivation alone.** The
/// derivation measures the write path on the grammar's probe, which its author
/// chooses. These documents are not: they carry the hostile trivia that
/// `guard_the_corpus_still_carries_its_traps` maintains, and a grammar that
/// reformats on write cannot escape them by bringing along a docile document.
///
/// The edit used is the same for all of them — a key at the root, under a name
/// no document carries — because an edit chosen document by document would hand
/// the author of a grammar control over what they are judged on.
///
/// **A grammar the table refuses is passed over, and said so.** It has no
/// `apply`, so this property has literally no object on its documents; that is
/// why they are filed by [`documents_admitted_to_merge`] with the refusal
/// itself, and why a run that dropped one instead would go red.
#[test]
fn c1_apply_then_invert_returns_the_preimage_byte_for_byte() {
    let edit = Edit::keys(&[], [(CONFORMANCE_KEY, Value::text("conformance value"))]);

    let documents = all_documents();
    let mut scope = Scope::new("`apply` then `invert` returns the pre-image byte for byte");

    for document in documents_admitted_to_merge(&documents, &mut scope) {
        let Document {
            path,
            grammar,
            bytes,
            text,
        } = document;
        if let Err(message) = refuse_a_document_already_carrying_the_key(&path, &text) {
            scope.fail(message);
            continue;
        }

        let applied = match grammar.apply(&text, &edit) {
            Ok(applied) => applied,
            Err(err) => {
                scope.fail(format!("{}: `apply` refused — {err}", path.display()));
                continue;
            }
        };

        // What the edit changes is a contiguous fragment: the document is not
        // re-emitted whole. Measured by subtracting the longest common prefix
        // and the longest common suffix — a re-emission pushes the whole
        // document out, a local edit a short fragment.
        let (removed, added) = difference(&text, &applied.rendered);
        if !removed.is_empty() {
            scope.fail(format!(
                "{}: {} byte(s) outside the trace disappeared on write — {removed:?}",
                path.display(),
                removed.len()
            ));
        }
        if !added.contains(CONFORMANCE_KEY) {
            scope.fail(format!(
                "{}: what appeared is not the key that was written — {added:?}",
                path.display()
            ));
        }

        match grammar.invert(&applied.rendered, &applied.inverse) {
            Err(err) => scope.fail(format!("{}: `invert` refused — {err}", path.display())),
            Ok(undone) => {
                if let Err(message) = compare_byte_identical(&path, &bytes, undone.as_bytes()) {
                    scope.fail(format!("after `apply` then `invert` — {message}"));
                }
            }
        }
    }

    scope.conclude(&documents);
}

/// The key the two write properties pose. It carries no meaning for any host
/// and no document of the repository holds it — which is what makes the edit
/// take the **add** branch on every one of them, and what would otherwise let a
/// corpus document quietly turn the measurement into a replacement.
const CONFORMANCE_KEY: &str = "rigger-conformance-absent-key";

fn refuse_a_document_already_carrying_the_key(path: &Path, text: &str) -> Result<(), String> {
    if text.contains(CONFORMANCE_KEY) {
        return Err(format!(
            "{}: the corpus already carries `{CONFORMANCE_KEY}` — the edit would replace a value \
             instead of adding one, and the property would no longer be the one it names",
            path.display()
        ));
    }
    Ok(())
}

/// The document as its owner leaves it after reindenting: the leading run of
/// spaces and tabs of every line is written twice, and not one other byte moves
/// — line endings included, so a CRLF document stays in CRLF and a document
/// indented with tabs is not converted to spaces.
///
/// Doubling rather than converting is what keeps the transformation total over
/// a corpus whose documents do not share a convention: each one is moved in its
/// own, none is rewritten into another's, and a line with no indentation stays
/// where it is. What the property needs is only that the bytes move while the
/// structure does not.
fn reindent(source: &str) -> String {
    let mut reindented = String::with_capacity(source.len() * 2);
    for line in source.split_inclusive('\n') {
        let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
        reindented.push_str(&line[..indent]);
        reindented.push_str(line);
    }
    reindented
}

/// Fourth common property: the inverse of an edit still applies after the
/// **owner of the document has reindented it**, and undoing gives his document
/// back as he reindented it — his new indentation included, byte for byte.
///
/// **What it establishes that the property above cannot.** `apply` then
/// `invert` hands the inverse the very bytes `apply` produced. An
/// implementation that recorded *where* it wrote — a byte offset, a line
/// number, a span — passes that unharmed while having addressed nothing by the
/// grammar. It is the owner's first reformat, or the host's, that then makes it
/// take the wrong bytes out, and it takes them out at **removal** time, which is
/// where nobody is looking and where the damage cannot be undone. C1 requires
/// that outside the trace the document come back unchanged, and C2 requires the
/// write to address the structure of the grammar and never lines: this property
/// is where those two meet, because a positional trace can satisfy the first
/// on a document nobody touched and violate it on every other.
///
/// The comparison is against the **reindented pre-image**, not the original: a
/// byte of the owner's new indentation the inverse fails to give back shows up
/// as a divergence, and so does any byte it takes beyond what the edit added.
///
/// The reindented document must also still be **readable** — an owner who
/// reindents does not leave the grammar behind — which is why `invert` refusing
/// is a failure here and not an expected outcome.
#[test]
fn c1_the_inverse_still_applies_after_the_owner_has_reindented_the_document() {
    let edit = Edit::keys(&[], [(CONFORMANCE_KEY, Value::text("conformance value"))]);

    let documents = all_documents();
    let mut scope = Scope::new("the inverse survives a reindentation by the owner");

    for document in documents_admitted_to_merge(&documents, &mut scope) {
        let Document {
            path,
            grammar,
            bytes: _,
            text,
        } = document;
        if let Err(message) = refuse_a_document_already_carrying_the_key(&path, &text) {
            scope.fail(message);
            continue;
        }

        let reindented_preimage = reindent(&text);
        if reindented_preimage == text {
            // The trial would then be the property above under another name.
            // Saying so is the point: a corpus document with no indentation at
            // all would make this one report green while measuring nothing.
            scope.fail(format!(
                "{}: reindenting this document changes no byte — it carries no indentation, so \
                 the trial would not move the bytes the inverse has to survive",
                path.display()
            ));
            continue;
        }

        let applied = match grammar.apply(&text, &edit) {
            Ok(applied) => applied,
            Err(err) => {
                scope.fail(format!("{}: `apply` refused — {err}", path.display()));
                continue;
            }
        };

        match grammar.invert(&reindent(&applied.rendered), &applied.inverse) {
            Err(err) => scope.fail(format!(
                "{}: `invert` refused on the reindented document — a trace addressed by the \
                 structure of the grammar does not stop applying because its owner moved the \
                 indentation: {err}",
                path.display()
            )),
            Ok(undone) => {
                if let Err(message) =
                    compare_byte_identical(&path, reindented_preimage.as_bytes(), undone.as_bytes())
                {
                    scope.fail(format!(
                        "after `apply`, a reindentation by the owner, then `invert` — {message}"
                    ));
                }
            }
        }
    }

    scope.conclude(&documents);
}

/// What disappeared and what appeared between two renderings, the longest
/// common prefix and the longest common suffix removed.
fn difference(before: &str, after: &str) -> (String, String) {
    let (a, b) = (before.as_bytes(), after.as_bytes());
    let prefix = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    let rest = a.len().min(b.len()) - prefix;
    let suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count()
        .min(rest);
    (
        String::from_utf8_lossy(&a[prefix..a.len() - suffix]).into_owned(),
        String::from_utf8_lossy(&b[prefix..b.len() - suffix]).into_owned(),
    )
}

/// The wiring itself: a document lives in `corpus-limits/` because its grammar
/// does not return its bytes, and that is what the capability table must say of
/// that grammar. Without this test, the table could admit to `merge` a grammar
/// whose counter-proof the repository carries.
#[test]
fn guard_the_limits_corpus_agrees_with_the_capability_table() {
    let documents = documents_in(&limits_corpus_dir());
    assert!(
        !documents.is_empty(),
        "{} is empty — the only document carrying the hard case would have vanished",
        limits_corpus_dir().display()
    );

    let mut failures = Vec::new();
    for path in &documents {
        let grammar = match CorpusGrammar::of(path) {
            Ok(grammar) => grammar,
            Err(err) => {
                failures.push(err);
                continue;
            }
        };
        let capabilities = grammar.capabilities();

        // What the table declares.
        if capabilities.preserves_trivia() {
            failures.push(format!(
                "{}: the table credits `{}` with preserving trivia",
                path.display(),
                capabilities.grammar()
            ));
        }
        if capabilities.merge_by_keys() == &MergeAdmission::Admitted {
            failures.push(format!(
                "{}: the table admits `{}` to the `merge` behaviour",
                path.display(),
                capabilities.grammar()
            ));
        }

        // What the document says of it, on the evidence: the real round trip
        // must diverge, failing which the table would be refusing on a limit
        // this repository no longer carries.
        if check_round_trip(path).is_ok() {
            failures.push(format!(
                "{}: the round trip is byte-identical — this document has no reason left to \
                 live outside tests/corpus/, and the table refuses `{}` on a limit that is gone",
                path.display(),
                capabilities.grammar()
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} disagreement(s) between the limits corpus and the capability table:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// A wiring guard across properties: the two write properties bear on the
/// documents of **every** grammar the capability table admits to `merge`, and
/// name the refusal on the documents of every grammar it refuses.
///
/// **Why neither property can establish this on its own.** Each of them decides
/// one document at a time, and a document nobody wrote is a document nobody
/// passes over: a grammar with no corpus document falls out of both properties
/// without either of them having anything to file. That is exactly how a
/// grammar can end up published, refused, and invisible — its line of the table
/// resting on its own probe, and the conformance run reading like coverage. The
/// state this file was in was one step milder and read the same way: a document
/// wired to a single property out of four.
///
/// A grammar refused the behaviour tomorrow falls out of the two write
/// properties legitimately — `apply` is what they exercise, and it does not
/// exist. What this guard forbids is that it fall out of them **quietly**.
#[test]
fn guard_the_write_properties_bear_on_every_admitted_grammar_and_name_every_refused_one() {
    let documents = all_documents();

    for grammar in CorpusGrammar::ALL {
        let name = grammar.capabilities().grammar();
        let of_this_grammar: Vec<PathBuf> = documents
            .iter()
            .filter(|path| {
                matches!(CorpusGrammar::of(path), Ok(routed) if routed.capabilities().grammar() == name)
            })
            .cloned()
            .collect();
        assert!(
            !of_this_grammar.is_empty(),
            "no document of the repository routes to grammar `{name}` — the write properties would \
             neither bear on it nor name it, and nothing would distinguish that from coverage"
        );

        let mut scope = Scope::new("the write properties account for every published grammar");
        let admitted = documents_admitted_to_merge(&of_this_grammar, &mut scope);

        match grammar.capabilities().merge_by_keys() {
            MergeAdmission::Admitted => assert_eq!(
                admitted.len(),
                of_this_grammar.len(),
                "grammar `{name}` is admitted to `merge` and only {} of its {} corpus document(s) \
                 reach the write properties — an admission nothing exercises is an admission \
                 nobody measured. Passed over:\n{}",
                admitted.len(),
                of_this_grammar.len(),
                scope.out_of_scope_report()
            ),
            MergeAdmission::Refused(refusal) => {
                assert!(
                    admitted.is_empty(),
                    "grammar `{name}` is refused `merge` and {} of its corpus document(s) reach \
                     the write properties anyway — they would exercise a write path the table \
                     says does not exist",
                    admitted.len()
                );
                let unnamed: Vec<String> = of_this_grammar
                    .iter()
                    .filter(|path| {
                        !scope.out_of_scope.iter().any(|(filed, reason)| {
                            filed == *path
                                && matches!(reason, OutOfScope::MergeRefused(named) if named.grammar() == name)
                        })
                    })
                    .map(|path| format!("  {}", path.display()))
                    .collect();
                assert!(
                    unnamed.is_empty(),
                    "grammar `{name}` is refused `merge` — «{refusal}» — and {} of its corpus \
                     document(s) are passed over without that refusal being carried:\n{}",
                    unnamed.len(),
                    unnamed.join("\n")
                );
            }
        }
    }
}

/// A wiring guard, not a grammar property: the capability table and the routing
/// of this file are **two hand-written lists**, and nothing brought them
/// together. A grammar could therefore be published without any of the
/// properties of this file ever crossing it.
///
/// **What this guard no longer does, and why.** It demanded that at least one
/// corpus document **route** to every published grammar, and that routing is
/// done by file extension. The second witness it claimed to bring was therefore
/// chosen by the author of the grammar being judged: they only had to drop a
/// docile document carrying the extension they declared to never be exercised
/// on the hostile documents of the repository. The second witness now lives in
/// the derivation itself — every grammar is offered the whole `SHARED_CORPUS`,
/// with no regard for extension — and what is checked here is that it did read
/// something of it.
#[test]
fn guard_every_published_grammar_is_exercised_on_the_corpus() {
    let table = rigger_grammar::table();

    let mut published: Vec<&str> = table
        .iter()
        .map(|capabilities| capabilities.grammar())
        .collect();
    published.sort_unstable();

    let mut routed: Vec<&str> = CorpusGrammar::ALL
        .iter()
        .map(|grammar| grammar.capabilities().grammar())
        .collect();
    routed.sort_unstable();

    assert_eq!(
        published, routed,
        "the capability table and the corpus routing do not describe the same set of grammars — \
         one of the two publishes or exercises a grammar the other ignores"
    );

    let orphans: Vec<&str> = table
        .iter()
        .filter(|capabilities| capabilities.shared_corpus_documents_read() == 0)
        .map(|capabilities| capabilities.grammar())
        .collect();

    assert!(
        orphans.is_empty(),
        "{} published grammar(s) reading no document of the repository — what the table says of \
         them rests on their own probe alone: {}",
        orphans.len(),
        orphans.join(", ")
    );
}

/// A wiring guard: the corpus the derivation embeds must be the one the
/// repository carries, document for document and byte for byte.
///
/// Without it, a document added to `tests/corpus/` would be exercised by the
/// properties of this file but never offered to the grammars, and a document
/// embedded from an earlier state of the repository would have preservation
/// measured on bytes nobody reads any more. Both read the same way from here:
/// the embedded list and the directory no longer describe the same set.
#[test]
fn guard_the_embedded_corpus_is_the_one_the_repository_carries() {
    let on_disk: Vec<(String, Vec<u8>)> = corpus_entries()
        .iter()
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_else(|| panic!("{}: non-UTF-8 file name", path.display()))
                .to_string();
            let bytes = fs::read(path)
                .unwrap_or_else(|err| panic!("{}: cannot read — {err}", path.display()));
            (name, bytes)
        })
        .collect();

    let embedded: Vec<(String, Vec<u8>)> = rigger_grammar::SHARED_CORPUS
        .iter()
        .map(|(name, source)| ((*name).to_string(), source.as_bytes().to_vec()))
        .collect();

    let names = |set: &[(String, Vec<u8>)]| -> Vec<String> {
        set.iter().map(|(name, _)| name.clone()).collect()
    };
    assert_eq!(
        names(&embedded),
        names(&on_disk),
        "the corpus embedded by the derivation does not name the same documents as {}",
        corpus_dir().display()
    );

    let divergent: Vec<&str> = embedded
        .iter()
        .zip(on_disk.iter())
        .filter(|((_, embedded_bytes), (_, disk_bytes))| embedded_bytes != disk_bytes)
        .map(|((name, _), _)| name.as_str())
        .collect();
    assert!(
        divergent.is_empty(),
        "{} embedded document(s) whose bytes are no longer those of the repository: {}",
        divergent.len(),
        divergent.join(", ")
    );
}

/// A fixture guard, not a grammar property: a `commented.json` run through a
/// "format on save", or one whose comments had disappeared, would make the
/// round trip trivially true and would make the test above lie without it ever
/// going red. This guard checks that the traps are still there; it checks
/// nothing about `jsonc-parser` or `toml_edit`.
///
/// Every needle anchors the trap it names, with enough context to be
/// unambiguous — never a character class. A needle `b"//"` would stay true even
/// if `// personal — do not touch` (the GIVEN of MD-22) disappeared, as long as
/// `// keep` (MD-24) remains in the file: it would prove an absent trap by
/// pointing at another. Every needle is checked even if an earlier one is
/// missing, for the same reason as A3 just above: one lost trap must not hide
/// the following ones in the report.
#[test]
fn guard_the_corpus_still_carries_its_traps() {
    let commented = fs::read(corpus_dir().join("commented.json")).expect("read commented.json");
    let settings = fs::read(corpus_dir().join("settings.json")).expect("read settings.json");
    let config = fs::read(corpus_dir().join("config.toml")).expect("read config.toml");

    let mut missing: Vec<String> = Vec::new();

    // CRLF line ending: a count, not a presence. Since A2, the multi-line block
    // needle below itself contains three `\r\n`; a bare presence of `b"\r\n"`
    // could therefore never again be the missing trap — and the count catches,
    // as a bonus, a partial conversion, which no presence needle can see. Same
    // idiom as `known_limits.rs` for the 24 CRs of `config-crlf.toml`.
    let cr_count = commented.iter().filter(|&&b| b == b'\r').count();
    if cr_count != 22 {
        missing.push(format!(
            "commented.json: trap \"CRLF line ending\" weakened — {cr_count} \\r found, 22 expected"
        ));
    }

    for (file, haystack, label, needle) in [
        (
            "commented.json",
            &commented,
            "MD-22 comment attached to theme (\"// personal — do not touch\")",
            b"// personal \xe2\x80\x94 do not touch\r\n  \"theme\"" as &[u8],
        ),
        (
            "commented.json",
            &commented,
            "multi-line block comment, CRLF inside the token",
            b"/*\r\n         * reviewed by hand\r\n         * do not remove\r\n         */",
        ),
        (
            "commented.json",
            &commented,
            "trailing comma before the closing brace",
            b",\r\n}",
        ),
        (
            "commented.json",
            &commented,
            "first element of the instructions array shares its line (MD-24)",
            b"\"instructions\": [\"AGENTS.md\"",
        ),
        (
            "commented.json",
            &commented,
            "end-of-line comment // keep, on the instructions array (MD-24 § AND)",
            b"\"docs/notes.md\"], // keep",
        ),
        (
            "commented.json",
            &commented,
            "2-space indentation after the object opens",
            b"{\r\n  \"",
        ),
        ("settings.json", &settings, "tab indentation", b"\t\""),
        (
            "settings.json",
            &settings,
            "space-indented block",
            b"        \"temperature\"",
        ),
        ("settings.json", &settings, "key \"model\"", b"\"model\":"),
        ("settings.json", &settings, "key \"models\"", b"\"models\":"),
        (
            "config.toml",
            &config,
            "section comment \"# security\"",
            b"\n# security",
        ),
        (
            "config.toml",
            &config,
            "end-of-line comment, anchored on the value of name",
            b"\"  # locked",
        ),
        (
            "config.toml",
            &config,
            "multi-line array with a trailing comma",
            b"\"exec\",\n]",
        ),
        (
            "config.toml",
            &config,
            "inline table server_pool",
            b"server_pool = { primary =",
        ),
        (
            "config.toml",
            &config,
            "standard table [server], prefix shared with server_pool",
            b"\n[server]\n",
        ),
    ] {
        if !windows_contain(haystack, needle) {
            missing.push(format!(
                "{file}: trap \"{label}\" missing — the measurement would no longer bear on the expected hostile trivia"
            ));
        }
    }

    // "model" before "theme" (GIVEN of MD-22): the two keys are far apart, so
    // not a single contiguous needle — a position comparison, just as
    // unambiguous.
    match (
        find_bytes(&commented, b"\"model\":"),
        find_bytes(&commented, b"\"theme\":"),
    ) {
        (Some(model_at), Some(theme_at)) if model_at < theme_at => {}
        (Some(_), Some(_)) => missing.push(
            "commented.json: \"model\" is no longer before \"theme\" — the non-alphabetical order of the GIVEN of MD-22 is gone".to_string(),
        ),
        _ => missing.push(
            "commented.json: \"model\" and/or \"theme\" not found — their order cannot be checked".to_string(),
        ),
    }

    if !missing.is_empty() {
        panic!(
            "{} trap(s) lost on the corpus:\n\n{}",
            missing.len(),
            missing.join("\n")
        );
    }
}

fn windows_contain(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
