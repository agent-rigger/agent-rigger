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
//! `docs/specs/socle-neuf/tasks.md` § T1: no byte of the corpus is copied from
//! a real file on the machine, and the properties tested never read a value —
//! so the neutrality of the content costs the measurement nothing.
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

use std::fs;
use std::path::{Path, PathBuf};

use rigger_grammar::{
    Applied, Capabilities, Edit, Grammar, GrammarError, Inverse, Jsonc, MergeAdmission, Toml, Value,
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
        "the expected corpus holds three documents (opencode.json, settings.json, config.toml), {} found in {}",
        entries.len(),
        corpus_dir().display()
    );

    // Every document is checked even if an earlier one failed: one failure must
    // not hide the following ones in the run report.
    let failures: Vec<String> = entries
        .iter()
        .filter_map(|path| check_round_trip(path).err())
        .collect();

    if !failures.is_empty() {
        panic!(
            "{} document(s) out of {} not byte-identical after a round trip with no edit:\n\n{}",
            failures.len(),
            entries.len(),
            failures.join("\n\n")
        );
    }
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
#[test]
fn c1_apply_then_invert_returns_the_preimage_byte_for_byte() {
    const KEY: &str = "rigger-conformance-absent-key";
    let edit = Edit::keys(&[], [(KEY, Value::text("conformance value"))]);

    let documents = all_documents();
    let mut exercised = 0;
    let mut failures = Vec::new();

    for path in &documents {
        let Ok(grammar) = CorpusGrammar::of(path) else {
            continue;
        };
        if grammar.capabilities().merge() != &MergeAdmission::Admitted {
            continue;
        }
        let Ok((input, text)) = read_utf8(path) else {
            continue;
        };
        assert!(
            !text.contains(KEY),
            "{}: the corpus already carries the conformance key",
            path.display()
        );

        let applied = match grammar.apply(&text, &edit) {
            Ok(applied) => applied,
            Err(err) => {
                failures.push(format!("{}: `apply` refused — {err}", path.display()));
                continue;
            }
        };
        exercised += 1;

        // What the edit changes is a contiguous fragment: the document is not
        // re-emitted whole. Measured by subtracting the longest common prefix
        // and the longest common suffix — a re-emission pushes the whole
        // document out, a local edit a short fragment.
        let (removed, added) = difference(&text, &applied.rendered);
        if !removed.is_empty() {
            failures.push(format!(
                "{}: {} byte(s) outside the trace disappeared on write — {removed:?}",
                path.display(),
                removed.len()
            ));
        }
        if !added.contains(KEY) {
            failures.push(format!(
                "{}: what appeared is not the key that was written — {added:?}",
                path.display()
            ));
        }

        match grammar.invert(&applied.rendered, &applied.inverse) {
            Err(err) => failures.push(format!("{}: `invert` refused — {err}", path.display())),
            Ok(undone) => {
                if let Err(message) = compare_byte_identical(path, &input, undone.as_bytes()) {
                    failures.push(format!("after `apply` then `invert` — {message}"));
                }
            }
        }
    }

    assert!(
        exercised > 0,
        "no document of the corpus was edited — the property would bear on nothing"
    );
    assert!(
        failures.is_empty(),
        "{} document(s) whose write does not undo exactly:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
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
        if capabilities.merge() == &MergeAdmission::Admitted {
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

/// A fixture guard, not a grammar property: an `opencode.json` run through a
/// "format on save", or one whose comments had disappeared, would make the
/// round trip trivially true and would make the test above lie without it ever
/// going red. This guard checks that the traps are still there; it checks
/// nothing about `jsonc-parser` or `toml_edit`.
///
/// Every needle anchors the trap it names, with enough context to be
/// unambiguous — never a character class. A needle `b"//"` would stay true even
/// if `// perso — ne pas toucher` (the GIVEN of MD-22) disappeared, as long as
/// `// garder` (MD-24) remains in the file: it would prove an absent trap by
/// pointing at another. Every needle is checked even if an earlier one is
/// missing, for the same reason as A3 just above: one lost trap must not hide
/// the following ones in the report.
#[test]
fn guard_the_corpus_still_carries_its_traps() {
    let opencode = fs::read(corpus_dir().join("opencode.json")).expect("read opencode.json");
    let settings = fs::read(corpus_dir().join("settings.json")).expect("read settings.json");
    let config = fs::read(corpus_dir().join("config.toml")).expect("read config.toml");

    let mut missing: Vec<String> = Vec::new();

    // CRLF line ending: a count, not a presence. Since A2, the multi-line block
    // needle below itself contains three `\r\n`; a bare presence of `b"\r\n"`
    // could therefore never again be the missing trap — and the count catches,
    // as a bonus, a partial conversion, which no presence needle can see. Same
    // idiom as `known_limits.rs` for the 24 CRs of `config-crlf.toml`.
    let cr_count = opencode.iter().filter(|&&b| b == b'\r').count();
    if cr_count != 22 {
        missing.push(format!(
            "opencode.json: trap \"CRLF line ending\" weakened — {cr_count} \\r found, 22 expected"
        ));
    }

    for (file, haystack, label, needle) in [
        (
            "opencode.json",
            &opencode,
            "MD-22 comment attached to theme (\"// perso — ne pas toucher\")",
            b"// perso \xe2\x80\x94 ne pas toucher\r\n  \"theme\"" as &[u8],
        ),
        (
            "opencode.json",
            &opencode,
            "multi-line block comment, CRLF inside the token",
            b"/*\r\n         * revu manuellement\r\n         * ne pas retirer\r\n         */",
        ),
        (
            "opencode.json",
            &opencode,
            "trailing comma before the closing brace",
            b",\r\n}",
        ),
        (
            "opencode.json",
            &opencode,
            "first element of the instructions array shares its line (MD-24)",
            b"\"instructions\": [\"AGENTS.md\"",
        ),
        (
            "opencode.json",
            &opencode,
            "end-of-line comment // garder, on the instructions array (MD-24 § AND)",
            b"\"docs/notes.md\"], // garder",
        ),
        (
            "opencode.json",
            &opencode,
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
            "section comment \"# sécurité\"",
            b"\n# s\xc3\xa9curit\xc3\xa9",
        ),
        (
            "config.toml",
            &config,
            "end-of-line comment, anchored on the value of name",
            b"\"  # verrouill\xc3\xa9",
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
        find_bytes(&opencode, b"\"model\":"),
        find_bytes(&opencode, b"\"theme\":"),
    ) {
        (Some(model_at), Some(theme_at)) if model_at < theme_at => {}
        (Some(_), Some(_)) => missing.push(
            "opencode.json: \"model\" is no longer before \"theme\" — the non-alphabetical order of the GIVEN of MD-22 is gone".to_string(),
        ),
        _ => missing.push(
            "opencode.json: \"model\" and/or \"theme\" not found — their order cannot be checked".to_string(),
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
