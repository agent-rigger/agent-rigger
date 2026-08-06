//! The admission gate to the `merge` behaviour, in scenarios.
//!
//! Tests prefixed with an identifier carry the name of the scenario of
//! `docs/specs/socle-neuf/requirements.md` they realise. Those prefixed with
//! `guard_` realise none: they check that the scenarios still measure
//! something, as the fixture guard of `conformance.rs` does for the corpus. Two
//! of them guard a guard — the reading of the crate sources, on which C7 leans
//! — because a guard that stops holding without going red is the mode they
//! close.
//!
//! What these tests observe of C1, and what they leave to another crate: the
//! scenario asks that a transaction abort "before the document is replaced".
//! What is observed here is both narrower and stronger — the refusal falls at
//! **admission**, before the write path is reached. That the document on disk
//! is the one from before is observed where the write happens, in
//! `rigger-apply`.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_grammar::{
    Applied, Capabilities, Edit, Grammar, GrammarError, GrammarRole, Inverse, Jsonc,
    MergeAdmission, Probe, RefusalReason, Resolution, SemanticValue, Toml,
};

/// Copies content into a named temporary file and returns its path. Used to
/// observe that an owned document did not move while the admission gate was
/// being queried.
fn temporary_copy(name: &str, content: &[u8]) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("rigger-grammar-{name}-{}.tmp", std::process::id()));
    fs::write(&path, content)
        .unwrap_or_else(|err| panic!("cannot write the witness {} — {err}", path.display()));
    path
}

/// The probe of the test grammars of this file: JSONC syntax, with the three
/// dimensions of hostile trivia the derivation demands — CRLF line ending,
/// indented line, comment.
const JSONC_PROBE: &str = concat!(
    "{\r\n",
    "\t// probe\r\n",
    "\t\"allow\": [\"read\"]\r\n",
    "}\r\n",
);

/// A grammar that preserves everything but whose resolution depends on order.
/// It exists only to isolate the second refusal condition: neither of the two
/// grammars this crate carries is order-sensitive, and a rule checked only on
/// today's grammars would stop protecting the day another one arrives.
///
/// Its round trip goes through a real parser, and it must: since the derivation
/// demands that a grammar refuse what is not a document, an identity is
/// credited with nothing — and this grammar must **be** credited with
/// preservation, failing which the refusal measured here could come from C1
/// rather than from order.
struct OrderSensitiveProbe;

impl Grammar for OrderSensitiveProbe {
    const NAME: &'static str = "order-sensitive-probe";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::DependsOnOrder;
    const PROBE: Probe = Probe {
        source: JSONC_PROBE,
        comment: "// probe",
        list_path: &["allow"],
        value_present: "read",
        value_absent: "network",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Jsonc::round_trip(source)
    }

    fn find_string_in_list(
        _source: &str,
        _path: &[&str],
        _value: &str,
    ) -> Result<bool, GrammarError> {
        Err(GrammarError::unsupported(
            Self::NAME,
            "designating a list element",
        ))
    }

    // The write path is JSONC's, and it must be: since the derivation measures
    // it, a grammar that has none is refused for that — and the refusal
    // measured here could then come from writing rather than from order.
    fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
        Jsonc::apply(source, edit)
    }

    fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
        Jsonc::invert(source, inverse)
    }

    fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
        Jsonc::values(source)
    }
}

/// A grammar that announces everything and implements nothing: its resolution
/// declares itself independent of order, its probe carries the three dimensions
/// of hostile trivia, it really does read its document — and its rendering
/// reformats. This is the only way to write a lying capability — and the
/// derivation must bring it back to what it can actually do.
struct LyingGrammar;

impl Grammar for LyingGrammar {
    const NAME: &'static str = "liar";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
    const PROBE: Probe = Probe {
        source: JSONC_PROBE,
        comment: "// probe",
        list_path: &["allow"],
        value_present: "read",
        value_absent: "network",
    };

    fn round_trip(source: &str) -> Result<String, GrammarError> {
        Ok(Jsonc::round_trip(source)?.replace("\r\n", "\n"))
    }

    fn find_string_in_list(
        _source: &str,
        _path: &[&str],
        _value: &str,
    ) -> Result<bool, GrammarError> {
        Ok(true)
    }
}

#[test]
fn c1_a_grammar_that_does_not_preserve_aborts() {
    // GIVEN an owned document, on disk, in a grammar whose implementation does
    // not return the bytes outside the trace.
    let before = include_bytes!("corpus-limites/config-crlf.toml");
    let witness = temporary_copy("c1", before);

    // WHEN a write goes through it.
    let capabilities = Capabilities::of::<Toml>();
    let admission = capabilities.merge();

    // THEN the transaction aborts — here, before any write path.
    let refusal = match admission {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => {
            panic!(
                "`merge` admitted on a grammar that does not preserve the bytes outside the trace"
            )
        }
    };

    // AND the message names the grammar and what was not preserved.
    assert_eq!(refusal.grammar(), Toml::NAME);
    let message = refusal.to_string();
    for expected in ["toml", "merge", "line endings"] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }

    // AND the document on disk is the one from before.
    let after = fs::read(&witness).expect("read the witness back");
    assert_eq!(
        after.as_slice(),
        before.as_slice(),
        "the owned document moved while the admission gate was being queried"
    );
    fs::remove_file(&witness).expect("clean up the witness");
}

#[test]
fn c7_merge_is_refused_on_an_order_sensitive_grammar() {
    // GIVEN a grammar whose capability table declares that its resolution
    // depends on order — and which preserves everything else, so that the
    // refusal can come from nowhere else.
    let capabilities = Capabilities::of::<OrderSensitiveProbe>();
    assert!(
        capabilities.preserves_trivia(),
        "the probe must preserve trivia, failing which the refusal measured here could come from C1"
    );
    assert_eq!(capabilities.resolution(), Resolution::DependsOnOrder);

    // WHEN a descriptor declares a `merge` by keys on it.
    // THEN the refusal names the grammar and the behaviour.
    let refusal = match capabilities.merge() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => panic!("`merge` admitted on an order-sensitive grammar"),
    };
    assert_eq!(refusal.grammar(), OrderSensitiveProbe::NAME);
    assert_eq!(
        refusal.reasons(),
        [RefusalReason::ResolutionDependsOnOrder],
        "the refusal must carry the one reason that motivates it, and no other"
    );
    let message = refusal.to_string();
    for expected in ["order-sensitive-probe", "merge", "order"] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }
}

#[test]
fn c7_the_condition_names_no_host() {
    // GIVEN the code that decides this refusal — the whole source of the crate,
    // because the decision reads the table and the table is populated by the
    // grammars: naming a host in one of them would amount to deciding by it.
    let sources = crate_sources();

    // The guard checks itself, and not by a floor: a floor is crossed the wrong
    // way without breaking anything — three files stay three files when the
    // fourth moves down a level and stops being read. What is checked here is
    // **derived**: every module the crate declares has indeed been read. The
    // compiler demands one file per module; the guard demands that this file
    // passed under its eyes.
    let unread = modules_without_a_file(&sources);
    assert!(
        unread.is_empty(),
        "{} module(s) declared by the crate whose source was not read — the guard below would \
         not bear on them:\n{}",
        unread.len(),
        unread.join("\n")
    );

    // WHEN it is inspected.
    // THEN it contains no host name.
    let mut faults = Vec::new();
    for (path, content) in &sources {
        let lowercase = content.to_lowercase();
        for host in [
            "claude",
            "anthropic",
            "codex",
            "opencode",
            "cursor",
            "copilot",
            "gemini",
            "windsurf",
        ] {
            if lowercase.contains(host) {
                faults.push(format!("{path} names the host \"{host}\""));
            }
        }
    }
    assert!(
        faults.is_empty(),
        "the admission condition must derive from a property of the grammar, never from a list \
         of hosts:\n{}",
        faults.join("\n")
    );
}

#[test]
fn c7_the_grammar_of_the_served_host_is_admitted() {
    // GIVEN the grammar of the settings file of the host that is served, whose
    // resolution goes by category and not by position.
    let capabilities = Capabilities::of::<Jsonc>();
    assert_eq!(capabilities.resolution(), Resolution::IndependentOfOrder);

    // WHEN a descriptor declares a `merge` by keys on it.
    // THEN it is accepted.
    assert_eq!(
        capabilities.merge(),
        &MergeAdmission::Admitted,
        "`merge` must stay open on the grammar of the only host that is served"
    );
}

/// A guard, not a scenario: this is what makes a capability announced without
/// an implementation impossible to sustain. The lying grammar declares
/// everything; the derivation runs it and brings it back to what it really
/// does.
#[test]
fn guard_a_capability_announced_without_an_implementation_does_not_hold() {
    let capabilities = Capabilities::of::<LyingGrammar>();

    assert!(
        !capabilities.preserves_trivia(),
        "a grammar that reformats was credited with preserving trivia"
    );
    assert!(
        !capabilities.designates_list_element(),
        "a grammar whose search answers without looking at the document was credited with \
         designating a list element"
    );
    assert!(
        matches!(capabilities.merge(), MergeAdmission::Refused(_)),
        "a grammar that preserves nothing was admitted to `merge`"
    );
}

/// A guard, not a scenario: it checks that the derivation **measured**
/// something for every published grammar, and it iterates `table()` rather than
/// enumerate today's grammars.
///
/// What it replaced, and why. The previous version listed by hand the traps
/// expected of two probes; it therefore stopped protecting at the third
/// grammar, the one nobody thought to add to it — and that is exactly how a
/// grammar destroying comments could be published as "preserves trivia" in a
/// copy of this crate. The dimensions are now demanded by the derivation
/// itself, for every grammar; what remains here is the observation that no
/// published grammar is refused for a defect of **instrument**, that is, that
/// none escapes the measurement instead of undergoing it.
#[test]
fn guard_no_published_grammar_escapes_the_measurement() {
    let escaped: Vec<String> = rigger_grammar::table()
        .iter()
        .filter_map(|capabilities| {
            let MergeAdmission::Refused(refusal) = capabilities.merge() else {
                return None;
            };
            let instrument: Vec<String> = refusal
                .reasons()
                .iter()
                .filter(|reason| {
                    matches!(
                        reason,
                        RefusalReason::ProbeWithoutHostileTrivia { .. }
                            | RefusalReason::ProbeCommentIsNotTrivia(_)
                            | RefusalReason::ProbeUnreadable(_)
                            | RefusalReason::MalformedDocumentAccepted { .. }
                            | RefusalReason::NoSharedCorpusDocument
                    )
                })
                .map(|reason| reason.to_string())
                .collect();
            (!instrument.is_empty()).then(|| {
                format!(
                    "grammar `{}`: {}",
                    capabilities.grammar(),
                    instrument.join(" ; ")
                )
            })
        })
        .collect();

    assert!(
        escaped.is_empty(),
        "{} published grammar(s) whose preservation could not be measured — their line of the \
         table says nothing about what they do:\n{}",
        escaped.len(),
        escaped.join("\n")
    );
}

/// A grammar whose probe carries no hostile trivia would have preservation
/// measured on a document with nothing to preserve, and a round trip that
/// reformats would pass for faithful on it. This guard is not enough as a test:
/// it is **also** a rule of the derivation, failing which it would cover only
/// the grammars somebody thought to enumerate.
#[test]
fn guard_a_probe_without_hostile_trivia_credits_nothing() {
    struct SilentProbe;

    impl Grammar for SilentProbe {
        const NAME: &'static str = "silent-probe";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: "allow = []\n",
            comment: "",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Ok(source.to_string())
        }

        fn find_string_in_list(
            _source: &str,
            _path: &[&str],
            _value: &str,
        ) -> Result<bool, GrammarError> {
            Err(GrammarError::unsupported(
                Self::NAME,
                "designating a list element",
            ))
        }
    }

    let capabilities = Capabilities::of::<SilentProbe>();
    assert!(
        !capabilities.preserves_trivia(),
        "a grammar measured on a probe without trivia was credited with preserving it"
    );
    assert!(
        matches!(capabilities.merge(), MergeAdmission::Refused(_)),
        "a grammar whose preservation could not be measured was admitted to `merge`"
    );
}

/// A guard, not a scenario: the **published motive** of a refusal must be the
/// one that really motivates it.
///
/// The TOML grammar is read-only by the product decision of 2026-08-06 — its
/// writing role was the configuration file of a host that is no longer served,
/// and no document owned by the host that is served is in TOML. The file plan
/// draws from it a categorical refusal, "as on `frontmatter_read`", which is
/// refused because it does not write and not because a library loses bytes. A
/// refusal publishing only the loss of line endings tells its reader that
/// fixing the library would reopen the gate, which is false.
#[test]
fn guard_a_read_only_refusal_names_the_decision_and_not_the_library() {
    let capabilities = Capabilities::of::<Toml>();
    let refusal = match capabilities.merge() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => panic!("`merge` admitted on a read-only grammar"),
    };

    let message = refusal.to_string();
    assert!(
        message.contains("read-only"),
        "the refusal does not publish the reason that motivates it — the product decision not to \
         write this grammar: {message}"
    );

    // AND the two reasons are published separately, the categorical one first:
    // the one no measurement lifts, then the one that is measured. A refusal
    // giving only one of them would suggest that lifting that one would be
    // enough.
    assert_eq!(
        refusal.reasons().first(),
        Some(&RefusalReason::ReadOnlyGrammar)
    );
    assert!(
        refusal
            .reasons()
            .iter()
            .any(|reason| matches!(reason, RefusalReason::TriviaNotPreserved(_))),
        "the limit measured on the library has disappeared from the refusal: {message}"
    );
}

/// A guard, not a scenario: the corollary of the previous one, and the one that
/// costs.
///
/// The conduct this module prescribed was to let admission reopen "by itself"
/// the day the library fixed its line endings. It would have reopened on a
/// grammar the product has decided not to write. This grammar simulates that
/// day: read-only, a real parser, a byte-identical round trip, a resolution
/// independent of order — everything that can be measured is green, and the
/// refusal holds.
#[test]
fn guard_a_fixed_library_does_not_reopen_a_read_only_grammar() {
    struct ReadOnlyThatPreservesEverything;

    impl Grammar for ReadOnlyThatPreservesEverything {
        const NAME: &'static str = "faithful-read-only";
        const ROLE: GrammarRole = GrammarRole::ReadOnly;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: JSONC_PROBE,
            comment: "// probe",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Jsonc::round_trip(source)
        }

        fn find_string_in_list(
            source: &str,
            path: &[&str],
            value: &str,
        ) -> Result<bool, GrammarError> {
            Jsonc::find_string_in_list(source, path, value)
        }
    }

    let capabilities = Capabilities::of::<ReadOnlyThatPreservesEverything>();
    assert!(
        capabilities.preserves_trivia(),
        "the grammar of this test must preserve trivia, failing which it does not simulate the \
         day the library gets fixed"
    );
    assert!(capabilities.designates_list_element());

    let refusal = match capabilities.merge() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => panic!(
            "admission reopened on a read-only grammar because everything that is measured turned \
             green"
        ),
    };
    assert_eq!(refusal.grammar(), ReadOnlyThatPreservesEverything::NAME);
    assert_eq!(
        refusal.reasons(),
        [RefusalReason::ReadOnlyGrammar],
        "the refusal must carry the one reason that motivates it, and no other"
    );
}

/// A guard, not a scenario: an implementation whose round trip **returns its
/// input unchanged** trivially preserves any probe. It would be credited with
/// preserving trivia, and admitted to `merge`, without any parser existing and
/// without anything of the document having been understood. That is the
/// counter-proof this crate carried itself: its order-sensitive test grammar
/// had exactly this shape.
///
/// What tells a grammar apart from an identity function is measurable: a
/// grammar **refuses** what is not a document of its syntax.
#[test]
fn guard_a_round_trip_without_a_parser_credits_nothing() {
    struct WithoutParser;

    impl Grammar for WithoutParser {
        const NAME: &'static str = "no-parser";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: JSONC_PROBE,
            comment: "// probe",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Ok(source.to_string())
        }

        fn find_string_in_list(
            _source: &str,
            _path: &[&str],
            _value: &str,
        ) -> Result<bool, GrammarError> {
            Err(GrammarError::unsupported(
                Self::NAME,
                "designating a list element",
            ))
        }
    }

    let capabilities = Capabilities::of::<WithoutParser>();
    assert!(
        !capabilities.preserves_trivia(),
        "an implementation returning its input unchanged was credited with preserving trivia — \
         the measurement does not tell a grammar apart from an identity"
    );
    assert!(
        matches!(capabilities.merge(), MergeAdmission::Refused(_)),
        "an implementation with no parser was admitted to `merge`"
    );
}

/// A guard, not a scenario: hostile trivia has several dimensions, and a probe
/// carrying only one of them measures preservation on the dimensions it carries
/// alone. The derivation therefore demands **all** of them, by itself — a guard
/// enumerating grammars by hand stops protecting at the first one somebody
/// forgets to add.
#[test]
fn guard_a_probe_silent_on_one_dimension_credits_nothing() {
    /// A real parser — it refuses what is not a document — whose rendering
    /// **destroys comments**. Its probe carries nothing but line endings: the
    /// destruction does not show there.
    struct DestroysComments;

    impl Grammar for DestroysComments {
        const NAME: &'static str = "destroys-comments";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: "{\r\n\t\"allow\": [\"read\"]\r\n}\r\n",
            comment: "",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            let rendered = Jsonc::round_trip(source)?;
            let mut without_comments: String = rendered
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\r\n");
            if rendered.ends_with("\r\n") {
                without_comments.push_str("\r\n");
            }
            Ok(without_comments)
        }

        fn find_string_in_list(
            _source: &str,
            _path: &[&str],
            _value: &str,
        ) -> Result<bool, GrammarError> {
            Err(GrammarError::unsupported(
                Self::NAME,
                "designating a list element",
            ))
        }
    }

    let capabilities = Capabilities::of::<DestroysComments>();
    assert!(
        !capabilities.preserves_trivia(),
        "a grammar that destroys comments was credited with preserving trivia, because its probe \
         carried none"
    );
    assert!(
        matches!(capabilities.merge(), MergeAdmission::Refused(_)),
        "a grammar that destroys comments was admitted to `merge`"
    );
}

/// A guard, not a scenario: the probe is written by the author of the grammar
/// being judged, so it carries only the trivia they were willing to put in it.
/// The three dimensions the derivation demands close nothing but what they
/// name — a **form** of comment absent from the probe stays a blind spot, and
/// the grammar below occupies exactly that spot: a real parser, a probe honest
/// on the three dimensions, and a rendering that **destroys block comments**, a
/// form its probe does not contain.
///
/// What that imposes on the derivation: measuring on documents the author of
/// the grammar did not choose too. The repository carries some, and their traps
/// are guarded by `conformance.rs`, which belongs to no grammar.
#[test]
fn guard_destroying_trivia_absent_from_the_probe_credits_nothing() {
    struct DestroysBlockComments;

    impl Grammar for DestroysBlockComments {
        const NAME: &'static str = "destroys-block-comments";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: JSONC_PROBE,
            comment: "// probe",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Ok(strip_block_comments(&Jsonc::round_trip(source)?))
        }

        fn find_string_in_list(
            source: &str,
            path: &[&str],
            value: &str,
        ) -> Result<bool, GrammarError> {
            Jsonc::find_string_in_list(source, path, value)
        }
    }

    // The probe of this grammar carries no block comment: their destruction is
    // invisible on it, and that is what makes the credit possible.
    assert!(
        !JSONC_PROBE.contains("/*"),
        "the probe of this test must ignore block comments, failing which the derivation would \
         catch the defect on the probe and would demonstrate nothing about the corpus"
    );

    let capabilities = Capabilities::of::<DestroysBlockComments>();
    assert!(
        !capabilities.preserves_trivia(),
        "a grammar that destroys block comments was credited with preserving trivia, because its \
         own probe carried none"
    );
    assert!(
        matches!(capabilities.merge(), MergeAdmission::Refused(_)),
        "a grammar that destroys block comments was admitted to `merge`"
    );
}

/// Strips the block comments from a rendered JSONC document. Enough for this
/// test: the document being measured contains none inside a string.
fn strip_block_comments(rendered: &str) -> String {
    let mut output = String::with_capacity(rendered.len());
    let mut rest = rendered;
    while let Some(opening) = rest.find("/*") {
        output.push_str(&rest[..opening]);
        match rest[opening + 2..].find("*/") {
            Some(closing) => rest = &rest[opening + 2 + closing + 2..],
            None => return output,
        }
    }
    output.push_str(rest);
    output
}

/// A guard, not a scenario: the proof that a parser exists is a **refusal**,
/// and a refusal can be counterfeited. The grammar below refuses whatever does
/// not begin with a brace and returns everything else unchanged: no byte is
/// parsed, and both the probe and the corpus come back to it identical.
///
/// What it imposes: that the documents whose refusal the derivation demands be
/// derived from the document itself, and not merely prefixed with a public
/// constant. A document followed by what is not one, or concatenated with
/// itself, still begins with the same brace — telling them apart requires
/// reading the structure, that is, parsing.
#[test]
fn guard_a_sham_refusal_does_not_credit_a_parser() {
    struct ShamRefusal;

    impl Grammar for ShamRefusal {
        const NAME: &'static str = "sham-refusal";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: JSONC_PROBE,
            comment: "// probe",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            if source.trim_start().starts_with('{') {
                Ok(source.to_string())
            } else {
                Err(GrammarError::malformed(Self::NAME, "not a brace"))
            }
        }

        fn find_string_in_list(
            source: &str,
            path: &[&str],
            value: &str,
        ) -> Result<bool, GrammarError> {
            Jsonc::find_string_in_list(source, path, value)
        }
    }

    // The refusal is indeed the one the derivation used to ask for: the
    // document prefixed with what is not one is rejected.
    assert!(
        ShamRefusal::round_trip(&format!("{}{JSONC_PROBE}", rigger_grammar::NOT_A_DOCUMENT))
            .is_err(),
        "this grammar must pass the refusal trial as it was written, failing which it does not \
         demonstrate that the trial can be counterfeited"
    );

    // The constant being public, the most direct counterfeit is to recognise
    // it: `source.starts_with(NOT_A_DOCUMENT)`. It fails for the same reason as
    // the one above — most of the demanded mutations cannot be recognised by
    // their head, they begin with the very bytes of the document they derive
    // from.
    let unrecognisable = rigger_grammar::mutations(JSONC_PROBE)
        .into_iter()
        .filter(|(_, mutant)| !mutant.starts_with(rigger_grammar::NOT_A_DOCUMENT))
        .count();
    assert!(
        unrecognisable >= 2,
        "only {unrecognisable} mutation(s) escape a test on the head of the document — \
         recognising the public constant would be enough to pass for a parser"
    );

    let capabilities = Capabilities::of::<ShamRefusal>();
    assert!(
        !capabilities.preserves_trivia(),
        "an implementation returning its input unchanged was credited with preserving trivia, \
         because it refuses a line it did not need to read"
    );
    assert!(
        matches!(capabilities.merge(), MergeAdmission::Refused(_)),
        "an implementation with no parser was admitted to `merge`"
    );
}

/// A guard, not a scenario: it holds the **criterion** of the "resolution"
/// column, which must be the same for every grammar.
///
/// That criterion is: *no second candidate that a position would have to
/// separate*. TOML holds it by its format, which forbids defining a key twice.
/// JSONC does not hold it by its own — the format admits the duplicated name
/// and leaves the reader's behaviour undefined — so it must hold it by its
/// implementation: refuse while naming the key, rather than honour the first
/// occurrence in silence. Without that refusal, the column would be populated
/// by two contradictory criteria, and writing into the first block of a
/// document carrying two would be ineffective with no error and no trace if the
/// reader honours the second — the rationale of C7 word for word, on a security
/// rule.
#[test]
fn guard_a_duplicated_key_is_refused_rather_than_silently_arbitrated() {
    // GIVEN a document where the key of the path being read is defined twice,
    // and a value that is only in the second definition.
    const DUPLICATED_KEY: &str = concat!(
        "{\r\n",
        "\t\"permissions\": { \"deny\": [\"Bash(rm -rf *)\"] },\r\n",
        "\t\"permissions\": { \"deny\": [\"Read(./secrets/**)\"] }\r\n",
        "}\r\n",
    );

    // WHEN the grammar looks for that value in it.
    let refusal = Jsonc::find_string_in_list(
        DUPLICATED_KEY,
        &["permissions", "deny"],
        "Read(./secrets/**)",
    )
    .expect_err(
        "the value is in the document and the read answered without an error: it arbitrated \
         between two definitions of the same key instead of refusing",
    );

    // THEN the refusal names the grammar and the duplicated key.
    assert_eq!(refusal.grammar(), Jsonc::NAME);
    let message = refusal.to_string();
    for expected in ["jsonc", "permissions"] {
        assert!(
            message.contains(expected),
            "the refusal does not name \"{expected}\": {message}"
        );
    }

    // AND the same document without the duplicate reads normally — failing
    // which the refusal above would be a refusal of everything, and would
    // measure nothing.
    const SINGLE_KEY: &str = concat!(
        "{\r\n",
        "\t\"permissions\": { \"deny\": [\"Read(./secrets/**)\"] }\r\n",
        "}\r\n",
    );
    assert_eq!(
        Jsonc::find_string_in_list(SINGLE_KEY, &["permissions", "deny"], "Read(./secrets/**)"),
        Ok(true)
    );
}

/// A guard, not a scenario: the debt `capability.rs` carried in writing since
/// T3a, and that this slice collects.
///
/// The role of a grammar is a product **decision**, hence declared. For as long
/// as no grammar had a write path, declaring oneself writable cost nothing and
/// nothing could contradict it — it was a capability announced without an
/// implementation, the very thing this module exists to make false. The grammar
/// below preserves everything, reads the repository, designates a list element,
/// and declares itself writable without being able to write.
#[test]
fn guard_a_write_role_without_a_write_path_does_not_hold() {
    struct DeclaresWriteWithoutKnowingHow;

    impl Grammar for DeclaresWriteWithoutKnowingHow {
        const NAME: &'static str = "declares-write-without-knowing-how";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Jsonc::PROBE;

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Jsonc::round_trip(source)
        }

        fn find_string_in_list(
            source: &str,
            path: &[&str],
            value: &str,
        ) -> Result<bool, GrammarError> {
            Jsonc::find_string_in_list(source, path, value)
        }
    }

    let capabilities = Capabilities::of::<DeclaresWriteWithoutKnowingHow>();
    assert!(
        capabilities.preserves_trivia() && capabilities.designates_list_element(),
        "this grammar must be credited with everything that can be measured without writing, \
         failing which the refusal below could come from elsewhere"
    );
    assert!(
        !capabilities.applies_edits(),
        "a grammar with no write path was credited with writing"
    );

    let refusal = match capabilities.merge() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => {
            panic!(
                "`merge` admitted on a grammar that declares writing without being able to write"
            )
        }
    };
    assert!(
        matches!(refusal.reasons(), [RefusalReason::NoWritePath(_)]),
        "the refusal must carry the one reason that motivates it: {:?}",
        refusal.reasons()
    );
}

/// A guard, not a scenario: writing is not enough, one must be able to
/// **undo**, and to undo while returning the bytes from before.
///
/// The grammar below writes exactly like JSONC and almost undoes: its pre-image
/// comes back reformatted. A removal that reformats destroys the owner's work
/// at the spot where nobody is looking, and that destruction has no observable
/// at the moment of the **write** — which is why admission must measure it
/// beforehand, and not discover it afterwards.
#[test]
fn guard_an_inverse_that_does_not_return_the_preimage_credits_nothing() {
    struct UndoesByReformatting;

    impl Grammar for UndoesByReformatting {
        const NAME: &'static str = "undoes-by-reformatting";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Jsonc::PROBE;

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Jsonc::round_trip(source)
        }

        fn find_string_in_list(
            source: &str,
            path: &[&str],
            value: &str,
        ) -> Result<bool, GrammarError> {
            Jsonc::find_string_in_list(source, path, value)
        }

        fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
            Jsonc::apply(source, edit)
        }

        fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
            Ok(Jsonc::invert(source, inverse)?.replace("\r\n", "\n"))
        }

        fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
            Jsonc::values(source)
        }
    }

    let capabilities = Capabilities::of::<UndoesByReformatting>();
    assert!(
        !capabilities.applies_edits(),
        "a grammar whose inverse reformats was credited with writing"
    );

    let refusal = match capabilities.merge() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => {
            panic!("`merge` admitted on a grammar whose removal reformats the document")
        }
    };
    assert!(
        matches!(
            refusal.reasons(),
            [RefusalReason::InverseNotByteIdentical(_)]
        ),
        "the refusal must name what was not preserved on removal: {:?}",
        refusal.reasons()
    );
    assert!(
        refusal.to_string().contains("line endings"),
        "the refusal does not name what diverged: {refusal}"
    );
}

/// The published table, entry by entry. The expected values are written here
/// and **measured** over there: that is the only direction that protects, the
/// other would let production align itself on the test.
///
/// This test is **not** enough to guard the table, and never was: a grammar
/// added with a lying line makes it go red on a vector equality, which its
/// author lifts by writing the lie a second time here. What guards is the
/// derivation itself, and the comparison of this table with the corpus, in
/// `conformance.rs`.
#[test]
fn c6_the_table_publishes_each_derived_capability_per_grammar() {
    let table = rigger_grammar::table();
    let published: Vec<(&str, GrammarRole, bool, bool, bool, Resolution, bool)> = table
        .iter()
        .map(|capabilities| {
            (
                capabilities.grammar(),
                capabilities.role(),
                capabilities.preserves_trivia(),
                capabilities.designates_list_element(),
                capabilities.applies_edits(),
                capabilities.resolution(),
                capabilities.merge() == &MergeAdmission::Admitted,
            )
        })
        .collect();

    assert_eq!(
        published,
        vec![
            (
                Jsonc::NAME,
                GrammarRole::ReadWrite,
                true,
                true,
                true,
                Resolution::IndependentOfOrder,
                true
            ),
            (
                Toml::NAME,
                GrammarRole::ReadOnly,
                false,
                false,
                false,
                Resolution::IndependentOfOrder,
                false
            ),
        ]
    );
}

/// A guard of the guard: the reading of the sources must descend into
/// subdirectories.
///
/// It did not, and the defect did not show: a module moving down a level —
/// `jsonc.rs` becoming `jsonc/mod.rs`, the shape it will normally take when
/// slice T3b adds the write path to it — left the scope of the host-name guard
/// without anything going red. That is word for word the mode the rationale of
/// C7 describes: "stops protecting that day without anything going red".
#[test]
fn guard_the_source_reading_descends_into_subdirectories() {
    let root = temporary_directory("recursive-sources");
    fs::write(root.join("flat.rs"), "// flat\n").expect("write flat.rs");
    fs::create_dir(root.join("nested")).expect("create the subdirectory");
    fs::write(root.join("nested/mod.rs"), "// nested\n").expect("write nested/mod.rs");
    fs::write(root.join("not-rust.txt"), "ignored\n").expect("write the decoy");

    let read: Vec<String> = rust_sources(&root)
        .into_iter()
        .map(|(path, _)| path)
        .collect();

    assert_eq!(
        read,
        vec!["flat.rs".to_string(), "nested/mod.rs".to_string()],
        "the reading did not see the same thing as the compiler"
    );
    fs::remove_dir_all(&root).expect("clean up the fixture");
}

/// A guard of the guard: what replaces the `>= 3` floor.
///
/// A floor is only crossed from above: it lets through the disappearance of a
/// file from the scope of the reading, which is precisely the mode it was meant
/// to protect against. The count is therefore derived from what the crate
/// **declares**: a declared module whose source was not read is named.
#[test]
fn guard_the_source_reading_demands_one_file_per_declared_module() {
    let root = temporary_directory("module-sources");
    fs::write(
        root.join("lib.rs"),
        "pub mod present;\nmod nested;\npub mod ghost;\n",
    )
    .expect("write lib.rs");
    fs::write(root.join("present.rs"), "// present\n").expect("write present.rs");
    fs::create_dir(root.join("nested")).expect("create the subdirectory");
    fs::write(root.join("nested/mod.rs"), "// nested\n").expect("write nested/mod.rs");

    let missing = modules_without_a_file(&rust_sources(&root));

    assert_eq!(
        missing.len(),
        1,
        "one single module is without a file in this fixture, {} reported: {missing:?}",
        missing.len()
    );
    assert!(
        missing[0].contains("ghost"),
        "the module without a file is not named: {}",
        missing[0]
    );
    fs::remove_dir_all(&root).expect("clean up the fixture");
}

/// Reads the source of the crate. The path starts from `CARGO_MANIFEST_DIR`:
/// the guard must stay correct whatever the current directory of the test.
///
/// **`build.rs` is part of it**, and it must be: it is code of this crate, it
/// chooses the documents preservation is measured on, and a host name there
/// would decide just as surely as one in the middle of the derivation. Leaving
/// it out of scope would make the guard avoidable by moving down a level — the
/// mode the guard of the guard already closes for subdirectories.
fn crate_sources() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources = rust_sources(&root.join("src"));
    let build = root.join("build.rs");
    sources.push((
        "build.rs".to_string(),
        fs::read_to_string(&build)
            .unwrap_or_else(|err| panic!("{}: cannot read — {err}", build.display())),
    ));
    sources
}

/// Reads **recursively** the `.rs` files under `dir`, each returned with its
/// path relative to `dir`, sorted.
fn rust_sources(dir: &Path) -> Vec<(String, String)> {
    fn descend(dir: &Path, prefix: &str, read: &mut Vec<(String, String)>) {
        let entries = fs::read_dir(dir)
            .unwrap_or_else(|err| panic!("{}: source directory not found — {err}", dir.display()));
        for entry in entries.filter_map(|entry| entry.ok()) {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if path.is_dir() {
                descend(&path, &relative, read);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
                let content = fs::read_to_string(&path)
                    .unwrap_or_else(|err| panic!("{}: cannot read — {err}", path.display()));
                read.push((relative, content));
            }
        }
    }

    let mut read = Vec::new();
    descend(dir, "", &mut read);
    read.sort();
    read
}

/// The modules `sources` declares and whose body no file of `sources` carries.
/// The compiler already demands that file; what is checked here is that it has
/// been **read**.
fn modules_without_a_file(sources: &[(String, String)]) -> Vec<String> {
    let read: Vec<&str> = sources.iter().map(|(path, _)| path.as_str()).collect();
    let mut missing = Vec::new();

    for (path, content) in sources {
        // A module file — `lib.rs`, `mod.rs` — carries its children in its own
        // directory; any other file carries them in a directory named after it.
        let directory = match path.rsplit_once('/') {
            Some((parent, name)) => match name {
                "lib.rs" | "mod.rs" => parent.to_string(),
                _ => format!("{parent}/{}", name.trim_end_matches(".rs")),
            },
            None => match path.as_str() {
                "lib.rs" | "mod.rs" => String::new(),
                other => other.trim_end_matches(".rs").to_string(),
            },
        };

        for module in declared_modules(content) {
            let candidates = if directory.is_empty() {
                [format!("{module}.rs"), format!("{module}/mod.rs")]
            } else {
                [
                    format!("{directory}/{module}.rs"),
                    format!("{directory}/{module}/mod.rs"),
                ]
            };
            if !candidates
                .iter()
                .any(|candidate| read.contains(&&**candidate))
            {
                missing.push(format!(
                    "{path} declares `mod {module};` — none of {candidates:?} was read"
                ));
            }
        }
    }

    missing
}

/// The names of the modules declared by a source file, that is, those whose
/// body lives in another file: `mod x;`, never `mod x { … }`.
fn declared_modules(content: &str) -> Vec<&str> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line
                .strip_prefix("pub(crate) ")
                .or_else(|| line.strip_prefix("pub "))
                .unwrap_or(line);
            line.strip_prefix("mod ")
                .and_then(|rest| rest.strip_suffix(';'))
                .map(str::trim)
        })
        .collect()
}

/// Creates an empty temporary directory and returns its path.
fn temporary_directory(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("rigger-grammar-{name}-{}.dir", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path)
        .unwrap_or_else(|err| panic!("cannot create {} — {err}", path.display()));
    path
}
