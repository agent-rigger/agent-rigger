//! The admission gate to the `merge` behaviour, in scenarios.
//!
//! A test prefixed with an identifier realises that requirement. C7 is the one
//! this gate answers to: **a key-based `merge` is refused when the resolution
//! of the document depends on the order of its keys**, and the refusal must
//! derive from a property of the grammar — never from a list of host names,
//! which stops protecting the day a host changes without anything going red.
//! Those prefixed with `guard_` realise none: they check that the scenarios
//! still measure something, as the fixture guard of `conformance.rs` does for
//! the corpus. Two of them guard a guard — the reading of the crate sources, on
//! which C7 leans — because a guard that stops holding without going red is the
//! mode they close.
//!
//! What these tests observe of C1, and what they leave to another crate: the
//! scenario asks that a transaction abort "before the document is replaced".
//! What is observed here is both narrower and stronger — the refusal falls at
//! **admission**, before the write path is reached. That the document on disk
//! is the one from before is observed where the write happens, in
//! `rigger-apply`.

use std::fs;
use std::path::{Path, PathBuf};

use rigger_grammar::marker::{self, Marker, Pose, Wrapping};
use rigger_grammar::{
    Applied, Capabilities, Edit, Grammar, GrammarError, GrammarRole, Inverse, Jsonc,
    MergeAdmission, MergeForm, Probe, RefusalReason, Resolution, SemanticValue, Toml,
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

/// The probe of the instruction-file grammars of this file: text, whose
/// structure is its lines, carrying the three dimensions of hostile trivia the
/// derivation demands — CRLF line ending, indented line, comment.
const INSTRUCTION_PROBE: &str = concat!(
    "# house rules\r\n",
    "\tnever run a destructive command without asking\r\n",
    "// reviewed by hand, do not reorder\r\n",
    "the first rule that matches wins\r\n",
);

/// A grammar of **instruction files**: text whose structure is its lines, read
/// first-match-first, hence resolved by order.
///
/// **Its round trip returns its input, and that is its language rather than a
/// counterfeit.** Every text is a document of an instruction file, so nothing
/// it could refuse would tell a parser from an identity — and the derivation
/// says so where it matters: the form "these keys at this path" is refused on
/// it, naming that it accepts what is not a document. What is left is the form
/// this shape exists for, and the trial that decides it does not go through a
/// parser at all: it poses a block and asks the recogniser of this crate
/// whether it finds it again.
///
/// This is the family `marker` names as the object of the bounded block, and
/// no grammar of the crate parses one yet. Without it, the road C7 leaves open
/// on an order-sensitive grammar would be a road no test ever walks.
struct InstructionLines;

impl Grammar for InstructionLines {
    const NAME: &'static str = "instruction-lines";
    const ROLE: GrammarRole = GrammarRole::ReadWrite;
    const RESOLUTION: Resolution = Resolution::DependsOnOrder;
    const PROBE: Probe = Probe {
        source: INSTRUCTION_PROBE,
        comment: "// reviewed by hand, do not reorder",
        list_path: &["rules"],
        value_present: "the first rule that matches wins",
        value_absent: "nothing here says this",
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
    let before = include_bytes!("corpus-limits/config-crlf.toml");
    let witness = temporary_copy("c1", before);

    // WHEN a write goes through it.
    let capabilities = Capabilities::of::<Toml>();
    let admission = capabilities.merge_by_keys();

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
    let refusal = match capabilities.merge_by_keys() {
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
        capabilities.merge_by_keys(),
        &MergeAdmission::Admitted,
        "`merge` must stay open on the grammar of the only host that is served"
    );
}

/// The documents `G` reads that the block a pose writes would **destroy**: the
/// pose succeeds, and what it produced is no longer a document its own grammar
/// reads.
///
/// The block is posed by [`marker::place`], the very function a pose runs, and
/// it carries a **body** — a block with none is the one shape a pose never
/// writes, and it is the shape on which two comments a parser tolerates pass
/// for a block a document can carry.
///
/// **It deliberately does not call the derivation.** What the scenario below
/// observes is that the table agrees with what a pose actually does to a real
/// document; asking the derivation whether it agrees with itself would observe
/// nothing.
fn documents_the_block_would_destroy<G: Grammar>() -> Vec<String> {
    let marker = Marker::new("capability-derivation", "delimiter-trial");
    let body = ["a line a catalogue would pose"];
    let mut destroyed = Vec::new();

    for &(document, source) in rigger_grammar::SHARED_CORPUS {
        if G::round_trip(source).is_err() {
            continue;
        }
        for &wrapping in Wrapping::ALL {
            let pose = Pose {
                marker: &marker,
                address: document,
                roots: &[],
                traced: &[],
                posed: None,
                body: &body,
                wrapping,
            };
            let Ok(placed) = marker::place(source, &pose) else {
                continue;
            };
            if let Err(err) = G::round_trip(&placed.rendered) {
                destroyed.push(format!("{document} under {wrapping:?} — {err}"));
            }
        }
    }
    destroyed
}

#[test]
fn c7_the_bounded_block_is_refused_where_posing_it_would_destroy_the_document() {
    // GIVEN the grammar of the settings file of the host that is served, and
    // the documents of the repository it reads.
    let destroyed = documents_the_block_would_destroy::<Jsonc>();

    // The trial has an object: there is at least one document, read by this
    // grammar, that a posed block leaves unreadable. Without this the assertion
    // below would hold for a grammar nobody ever poses into.
    assert!(
        !destroyed.is_empty(),
        "no document of the repository read by this grammar is destroyed by a posed block — the \
         assertion below would then measure nothing"
    );

    // WHEN the capability table is asked whether the form "this block between
    // these bounds" is open on it.
    let capabilities = Capabilities::of::<Jsonc>();

    // THEN it is refused. A table answering "yes" here says a pose may write a
    // block into a document whose owner would stop being able to read it, and
    // the pose reports success while the host no longer loads its own settings.
    let refusal = match capabilities.merge_bounded_block() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => panic!(
            "the bounded block is admitted on a grammar whose documents a posed block \
             destroys:\n{}",
            destroyed.join("\n")
        ),
    };
    assert!(
        !capabilities.carries_delimiters(),
        "the column says the documents carry a block that would destroy them"
    );
    assert!(
        capabilities.delimiter_wrappings().is_empty(),
        "a wrapping is published as carriable on documents no wrapping survives: {:?}",
        capabilities.delimiter_wrappings()
    );
    assert!(
        refusal
            .reasons()
            .iter()
            .any(|reason| matches!(reason, RefusalReason::NoDelimiterTheDocumentCanCarry { .. })),
        "the refusal does not name the reason that motivates it: {:?}",
        refusal.reasons()
    );
}

#[test]
fn c7_an_order_sensitive_grammar_keeps_the_bounded_block() {
    // GIVEN a grammar whose resolution depends on order, and whose documents
    // can carry a block — text, whose structure is its lines.
    let capabilities = Capabilities::of::<InstructionLines>();
    assert_eq!(capabilities.resolution(), Resolution::DependsOnOrder);
    assert!(
        capabilities.carries_delimiters(),
        "the documents of this grammar are lines, so a block posed among them must be measured \
         as carriable — failing which the refusal below would prove nothing about order"
    );

    // WHEN a descriptor declares a `merge` on it in the form "this block
    // between these bounds".
    // THEN it is accepted: what order arbitrates is a position, and a block is
    // designated by its delimiters.
    assert_eq!(
        capabilities.merge_bounded_block(),
        &MergeAdmission::Admitted,
        "the road C7 leaves open on an order-sensitive grammar was closed"
    );

    // AND the other form is still refused, on the same grammar: the two verdicts
    // are read separately and do not follow from one another.
    assert!(
        matches!(capabilities.merge_by_keys(), MergeAdmission::Refused(_)),
        "the form the order of the document arbitrates was admitted"
    );
}

#[test]
fn c7_neither_form_is_available_when_the_document_carries_no_delimiter() {
    // GIVEN a grammar whose resolution depends on order **and** whose documents
    // cannot carry a comment. No grammar served today reunites the two
    // difficulties; this one exists so that the rule refuses of itself the day
    // one does, rather than the day somebody re-reads a note.
    //
    // It preserves what can be preserved, writes, undoes, and reads a document
    // of the repository: everything measurable is green except the two
    // properties under trial.
    struct StrictAndOrderSensitive;

    impl Grammar for StrictAndOrderSensitive {
        const NAME: &'static str = "strict-and-order-sensitive";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::DependsOnOrder;
        // No comment anywhere in it, because its language has none. That is
        // the second difficulty, and it is not declared: it is what makes the
        // trials below fail.
        const PROBE: Probe = Probe {
            source: "{\r\n\t\"allow\": [\"read\"]\r\n}\r\n",
            comment: "",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            strict(source)?;
            Jsonc::round_trip(source)
        }

        fn find_string_in_list(
            source: &str,
            path: &[&str],
            value: &str,
        ) -> Result<bool, GrammarError> {
            strict(source)?;
            Jsonc::find_string_in_list(source, path, value)
        }

        fn apply(source: &str, edit: &Edit) -> Result<Applied, GrammarError> {
            strict(source)?;
            Jsonc::apply(source, edit)
        }

        fn invert(source: &str, inverse: &Inverse) -> Result<String, GrammarError> {
            strict(source)?;
            Jsonc::invert(source, inverse)
        }

        fn values(source: &str) -> Result<Vec<SemanticValue>, GrammarError> {
            strict(source)?;
            Jsonc::values(source)
        }
    }

    /// The one thing this grammar does not share with JSONC: a slash is not a
    /// comment here, it is a syntax error. The bare token is no better — it is
    /// not a value of the language either, and JSONC rejects it on its own.
    fn strict(source: &str) -> Result<(), GrammarError> {
        if source.contains("//") || source.contains("/*") {
            return Err(GrammarError::malformed(
                StrictAndOrderSensitive::NAME,
                "this language has no comment",
            ));
        }
        Ok(())
    }

    let capabilities = Capabilities::of::<StrictAndOrderSensitive>();
    assert_eq!(capabilities.resolution(), Resolution::DependsOnOrder);
    assert!(
        !capabilities.carries_delimiters(),
        "a document that admits no comment and no bare line was credited with carrying a \
         delimiter"
    );
    // The write path is green: what refuses below is neither the absence of an
    // implementation nor a lost byte.
    assert!(capabilities.applies_edits());

    // WHEN a descriptor declares a `merge` on it, in one form or the other.
    // THEN both are refused, each naming the grammar and its own reason.
    let by_keys = match capabilities.merge_by_keys() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => {
            panic!("`merge` by keys admitted on an order-sensitive grammar")
        }
    };
    let bounded_block = match capabilities.merge_bounded_block() {
        MergeAdmission::Refused(refusal) => refusal,
        MergeAdmission::Admitted => {
            panic!("a bounded block admitted in a document that cannot carry a delimiter")
        }
    };

    assert_eq!(by_keys.grammar(), StrictAndOrderSensitive::NAME);
    assert_eq!(bounded_block.grammar(), StrictAndOrderSensitive::NAME);
    assert_eq!(by_keys.form(), MergeForm::Keys);
    assert_eq!(bounded_block.form(), MergeForm::BoundedBlock);

    // The reason of each is its own, and neither is the reason of the other.
    // That is the whole of this scenario: a refusal that gave one reason for
    // both would tell its reader that the road it does not name is open.
    assert!(
        by_keys
            .reasons()
            .contains(&RefusalReason::ResolutionDependsOnOrder),
        "the refusal of the keys does not name what arbitrates them: {:?}",
        by_keys.reasons()
    );
    assert!(
        !by_keys
            .reasons()
            .iter()
            .any(|reason| matches!(reason, RefusalReason::NoDelimiterTheDocumentCanCarry { .. })),
        "the refusal of the keys borrows the reason of the block"
    );
    // The refusal of the block carries the one reason that motivates it, and
    // above all not the order — order arbitrates a position, and a block is
    // designated by its delimiters. It carries one per document that can carry
    // none, and the probe is among them: this grammar reads its own document
    // and those of the repository its syntax admits.
    assert!(
        bounded_block
            .reasons()
            .iter()
            .all(|reason| matches!(reason, RefusalReason::NoDelimiterTheDocumentCanCarry { .. })),
        "the refusal of the block carries a reason that is not its own: {:?}",
        bounded_block.reasons()
    );
    assert!(
        bounded_block
            .reasons()
            .contains(&RefusalReason::NoDelimiterTheDocumentCanCarry {
                document: "the probe"
            }),
        "the refusal of the block does not name the document it was measured on: {:?}",
        bounded_block.reasons()
    );

    // The keys carry a second reason, and it is not noise: a document with no
    // comment has none in its probe either, so preservation cannot be measured
    // on that dimension. The two difficulties compound, and the refusal says so
    // rather than hide it behind the one everybody expected.
    assert_eq!(
        by_keys.reasons(),
        [
            RefusalReason::ProbeWithoutHostileTrivia {
                dimension: "comment"
            },
            RefusalReason::ResolutionDependsOnOrder,
        ]
    );

    // AND each message names the grammar, its form, and its reason — a reader
    // holding the two must be able to tell them apart.
    for (refusal, expected) in [
        (by_keys, ["these keys at this path", "order"]),
        (
            bounded_block,
            ["this block between these bounds", "delimiter"],
        ),
    ] {
        let message = refusal.to_string();
        for expected in expected.iter().chain(["strict-and-order-sensitive"].iter()) {
            assert!(
                message.contains(expected),
                "the refusal does not name \"{expected}\": {message}"
            );
        }
    }
}

/// A guard, not a scenario: the trial must pose **every** wrapping and keep
/// what survived, rather than settle for the one that suits the documents of
/// today.
///
/// A trial narrowed to one wrapping is a rule written by name in another
/// alphabet: it would go on answering "yes" the day a document changes format,
/// with nothing going red. And the fold into a single boolean is what this
/// checks on the other side — a caller has to pick a wrapping before it poses
/// anything, and "at least one of them works" names no road.
#[test]
fn guard_the_delimiter_trial_poses_every_wrapping() {
    let capabilities = Capabilities::of::<InstructionLines>();

    assert_eq!(
        capabilities.delimiter_wrappings(),
        Wrapping::ALL,
        "the documents of a line-oriented grammar carry all four wrappings — a published set \
         missing one is a wrapping the trial never posed"
    );
}

/// A guard, not a scenario: the half of the trial that says "the recogniser
/// finds the block again" must decide something.
///
/// A block the recogniser does not find delimits nothing: it is invisible,
/// hence unremovable, and every further pose appends another copy. The document
/// here makes that half, and only that half, fail: its last line is an
/// unterminated `/*`, which the lexer rightly treats as an ordinary line — and
/// a block-comment delimiter appended after it closes that opening instead of
/// being read as a delimiter of its own. The grammar reads the rendering
/// perfectly well, so the wrapping is refused by the recogniser or by nothing.
#[test]
fn guard_a_block_the_recogniser_cannot_find_again_is_not_carried() {
    /// The instruction-file grammar, on a document whose last line opens a
    /// block comment nobody closed. Prose does that.
    struct DanglingOpener;

    impl Grammar for DanglingOpener {
        const NAME: &'static str = "instruction-lines-dangling-opener";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::DependsOnOrder;
        const PROBE: Probe = Probe {
            source: concat!(
                "# house rules\r\n",
                "\tnever run a destructive command without asking\r\n",
                "// reviewed by hand, do not reorder\r\n",
                "the note below was never finished\r\n",
                "/*\r\n",
            ),
            comment: "// reviewed by hand, do not reorder",
            list_path: &["rules"],
            value_present: "the note below was never finished",
            value_absent: "nothing here says this",
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

    let capabilities = Capabilities::of::<DanglingOpener>();

    assert_eq!(
        capabilities.delimiter_wrappings(),
        [Wrapping::LineComment, Wrapping::Bare],
        "a wrapping whose delimiters the recogniser cannot find again in this document was \
         credited: the block would be posed, invisible, and duplicated by the next pose"
    );

    // What the two refused wrappings are refused **by**: not the grammar, which
    // reads any text of this language, but the recogniser reading back what the
    // writer produced. Drop that half of the trial and the two come back.
    for wrapping in [Wrapping::BlockCommentInline, Wrapping::BlockCommentSpanning] {
        let marker = Marker::new("capability-derivation", "delimiter-trial");
        let body = ["a line a catalogue would pose"];
        let pose = Pose {
            marker: &marker,
            address: "the probe",
            roots: &[],
            traced: &[],
            posed: None,
            body: &body,
            wrapping,
        };
        let refusal = marker::place(DanglingOpener::PROBE.source, &pose)
            .expect_err("the pose must refuse the wrapping the table does not publish");
        assert!(
            matches!(
                refusal,
                rigger_grammar::marker::PlaceError::NotRecognised { .. }
            ),
            "the wrapping is refused by something other than the recogniser: {refusal}"
        );
    }
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
        matches!(capabilities.merge_by_keys(), MergeAdmission::Refused(_)),
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
            let MergeAdmission::Refused(refusal) = capabilities.merge_by_keys() else {
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
        matches!(capabilities.merge_by_keys(), MergeAdmission::Refused(_)),
        "a grammar whose preservation could not be measured was admitted to `merge`"
    );
}

/// A guard, not a scenario: the **published motive** of a refusal must be the
/// one that really motivates it.
///
/// The TOML grammar is read-only by the product decision of 2026-08-06 — its
/// writing role was the configuration file of a host that is no longer served,
/// and no document owned by the host that is served is in TOML. The file plan
/// draws from it a **categorical** refusal: refused because the grammar does
/// not write, and never because a document resisted or a library lost bytes. A
/// refusal publishing only the loss of line endings tells its reader that
/// fixing the library would reopen the gate, which is false.
#[test]
fn guard_a_read_only_refusal_names_the_decision_and_not_the_library() {
    let capabilities = Capabilities::of::<Toml>();
    let refusal = match capabilities.merge_by_keys() {
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

    let refusal = match capabilities.merge_by_keys() {
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

/// A grammar that lies about `role`: it declares itself
/// [`GrammarRole::ReadOnly`] while every part of its write path — write, read
/// back, undo — is a real one, delegated whole to [`Jsonc`]. This is the
/// scenario [`RefusalReason::DeclaredReadOnlyYetWritable`] exists for: a
/// document underneath a `ReadOnly` declaration that has quietly become one
/// the product could write, with nothing in the derivation able to see it
/// before this slice, because the write path of a read-only grammar was never
/// even run.
struct LyingAboutReadOnly;

impl Grammar for LyingAboutReadOnly {
    const NAME: &'static str = "lying-about-read-only";
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

    fn find_string_in_list(source: &str, path: &[&str], value: &str) -> Result<bool, GrammarError> {
        Jsonc::find_string_in_list(source, path, value)
    }

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

#[test]
fn md39_2_a_grammar_that_lies_about_read_only_is_caught_by_measurement() {
    // GIVEN a grammar declared read-only whose write path — write, read
    // back, undo — is real and holds.
    let capabilities = Capabilities::of::<LyingAboutReadOnly>();
    assert!(
        capabilities.applies_edits(),
        "this grammar's write path must measure clean, failing which the scenario below is not \
         the one this guard exists for"
    );

    // WHEN both forms of `merge` are asked about it.
    // THEN both stay refused — role is a product decision, and no
    // measurement lifts it — but both now name that the decision no longer
    // rests on anything measured.
    for admission in [
        capabilities.merge_by_keys(),
        capabilities.merge_bounded_block(),
    ] {
        let refusal = match admission {
            MergeAdmission::Refused(refusal) => refusal,
            MergeAdmission::Admitted => {
                panic!("`merge` admitted on a grammar that declares itself read-only")
            }
        };
        assert!(
            refusal.reasons().contains(&RefusalReason::ReadOnlyGrammar),
            "the categorical reason must still be published: {:?}",
            refusal.reasons()
        );
        assert!(
            refusal
                .reasons()
                .contains(&RefusalReason::DeclaredReadOnlyYetWritable),
            "a grammar whose write path measures clean while declared read-only was not \
             flagged: {:?}",
            refusal.reasons()
        );
    }
}

/// A guard, not a scenario: the corollary that matters in production. Every
/// grammar `table()` publishes must **not** trip
/// [`RefusalReason::DeclaredReadOnlyYetWritable`]. If one ever does, that is
/// not a defect of this guard — it is news: a document this crate reads has
/// become one the product could write, and the grammar's own `ROLE`
/// declaration needs a human to revisit it, never a silent adjustment here.
///
/// For `toml`, this is expected to hold: [`Toml`] does not implement a write
/// path at all, so the measurement answers `NoWritePath`, not silence — the
/// measurement and the declaration agree that this grammar does not write,
/// for two different reasons that happen to point the same way.
#[test]
fn md39_2_no_published_grammar_contradicts_its_declared_role() {
    for capabilities in rigger_grammar::table() {
        for admission in [
            capabilities.merge_by_keys(),
            capabilities.merge_bounded_block(),
        ] {
            if let MergeAdmission::Refused(refusal) = admission {
                assert!(
                    !refusal
                        .reasons()
                        .contains(&RefusalReason::DeclaredReadOnlyYetWritable),
                    "{refusal} — the declared role of `{}` no longer agrees with what its \
                     write path measures",
                    capabilities.grammar()
                );
            }
        }
    }
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
        matches!(capabilities.merge_by_keys(), MergeAdmission::Refused(_)),
        "an implementation with no parser was admitted to `merge`"
    );

    // The bounded block is the one thing this grammar is **not** brought back
    // from, and that is measured rather than conceded. The form needs no
    // parser: a block is written on the lines of the document and read back by
    // the recogniser of this crate, never rendered by a grammar. A language
    // that accepts any text is the language an instruction file has, and it is
    // the family this form exists for — so the answer here is the same one an
    // honest instruction-file grammar gets, and refusing it would refuse the
    // form to the documents it was written for.
    //
    // What the counterfeit does buy is refused right beside it, on the same
    // line of the table: the form that does need a parser. A reader holding
    // both sees a grammar that accepts what is not a document, named.
    assert!(
        capabilities.carries_delimiters(),
        "a language that accepts any text cannot be broken by lines posed among its lines — \
         refusing here would refuse the form to the very documents it has an object on"
    );
    assert!(
        matches!(
            capabilities.merge_by_keys(),
            MergeAdmission::Refused(refusal)
                if refusal.reasons().iter().any(|reason| matches!(
                    reason,
                    RefusalReason::MalformedDocumentAccepted { .. }
                ))
        ),
        "the absence of a parser is not published anywhere a reader of this line would meet it: \
         {:?}",
        capabilities.merge_by_keys()
    );
}

/// A guard, not a scenario, and the demonstration of why the delimiter trial
/// does **not** demand a parser the way the trivia measurement does.
///
/// The trial that tells a parser from an identity is that the grammar refuses
/// its document followed by what is not one. A grammar strict enough to do that
/// has a significant tail — and the block a pose appends there is, to it, more
/// text after the end of the document. It refuses the block for the same reason
/// it refuses the mutation, so demanding a parser would not raise the bar on
/// this column: it would empty it, for good and for every grammar, including
/// the instruction files this form exists for.
///
/// The grammar below is a real parser by the derivation's own trial, and the
/// only thing it cannot carry is what a pose puts **between** the bounds.
#[test]
fn guard_demanding_a_parser_would_close_the_bounded_block_for_good() {
    /// Lines that are either a comment or `key = value`, no key twice, at least
    /// one. Its delimiters can be comments; the body a pose writes between them
    /// is a line of neither kind.
    struct KeyLines;

    impl KeyLines {
        fn reads(source: &str) -> Result<(), GrammarError> {
            let mut keys: Vec<&str> = Vec::new();
            for line in source.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with("//") {
                    continue;
                }
                let Some((key, _)) = line.split_once(" = ") else {
                    return Err(GrammarError::malformed(
                        Self::NAME,
                        format!("`{line}` is neither a comment nor a `key = value` line"),
                    ));
                };
                if keys.contains(&key) {
                    return Err(GrammarError::malformed(
                        Self::NAME,
                        format!("the key `{key}` is defined twice"),
                    ));
                }
                keys.push(key);
            }
            if keys.is_empty() {
                return Err(GrammarError::malformed(
                    Self::NAME,
                    "a document of this language carries at least one key",
                ));
            }
            Ok(())
        }
    }

    impl Grammar for KeyLines {
        const NAME: &'static str = "key-lines";
        const ROLE: GrammarRole = GrammarRole::ReadWrite;
        const RESOLUTION: Resolution = Resolution::IndependentOfOrder;
        const PROBE: Probe = Probe {
            source: "// probe\r\n\tallow = read\r\n",
            comment: "// probe",
            list_path: &["allow"],
            value_present: "read",
            value_absent: "network",
        };

        fn round_trip(source: &str) -> Result<String, GrammarError> {
            Self::reads(source)?;
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

    // It is a parser by the trial the derivation uses: no mutation of its
    // document is accepted, so nothing here is refused for want of one.
    let capabilities = Capabilities::of::<KeyLines>();
    let MergeAdmission::Refused(by_keys) = capabilities.merge_by_keys() else {
        panic!("this grammar has no write path — the keys cannot be admitted");
    };
    assert!(
        !by_keys
            .reasons()
            .iter()
            .any(|reason| matches!(reason, RefusalReason::MalformedDocumentAccepted { .. })),
        "the grammar was taken for an identity, so what follows would prove nothing: {:?}",
        by_keys.reasons()
    );

    // And it carries no block, under any wrapping: the delimiters are comments
    // it reads, and the body between them is a line of neither kind.
    assert!(
        capabilities.delimiter_wrappings().is_empty(),
        "a wrapping was credited on a document whose language the posed body leaves: {:?}",
        capabilities.delimiter_wrappings()
    );
    let MergeAdmission::Refused(bounded_block) = capabilities.merge_bounded_block() else {
        panic!("the block is admitted on a document a posed body makes unreadable");
    };
    assert!(
        bounded_block
            .reasons()
            .contains(&RefusalReason::NoDelimiterTheDocumentCanCarry {
                document: "the probe"
            }),
        "the refusal does not name the document that cannot carry: {:?}",
        bounded_block.reasons()
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
        matches!(capabilities.merge_by_keys(), MergeAdmission::Refused(_)),
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
        matches!(capabilities.merge_by_keys(), MergeAdmission::Refused(_)),
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
        matches!(capabilities.merge_by_keys(), MergeAdmission::Refused(_)),
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

    let refusal = match capabilities.merge_by_keys() {
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

    let refusal = match capabilities.merge_by_keys() {
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
    let published: Vec<Row> = table
        .iter()
        .map(|capabilities| Row {
            grammar: capabilities.grammar(),
            role: capabilities.role(),
            preserves_trivia: capabilities.preserves_trivia(),
            designates_list_element: capabilities.designates_list_element(),
            applies_edits: capabilities.applies_edits(),
            resolution: capabilities.resolution(),
            carries_delimiters: capabilities.carries_delimiters(),
            delimiter_wrappings: capabilities.delimiter_wrappings().to_vec(),
            merge_by_keys: capabilities.merge_by_keys() == &MergeAdmission::Admitted,
            merge_bounded_block: capabilities.merge_bounded_block() == &MergeAdmission::Admitted,
        })
        .collect();

    assert_eq!(
        published,
        vec![
            // The keys are open on it, the block is not, and the two answers
            // come from different measurements. Its documents are values, and
            // a block posed among them puts between its bounds lines that are
            // values of no language: the delimiters can be comments this
            // grammar tolerates, and what stands between them makes the file
            // unreadable — for this grammar, and for the host whose settings
            // it is.
            Row {
                grammar: Jsonc::NAME,
                role: GrammarRole::ReadWrite,
                preserves_trivia: true,
                designates_list_element: true,
                applies_edits: true,
                resolution: Resolution::IndependentOfOrder,
                carries_delimiters: false,
                delimiter_wrappings: Vec::new(),
                merge_by_keys: true,
                merge_bounded_block: false,
            },
            // Read-only by product decision, so no form of `merge` is open on
            // it — and its documents carry no block either, for the same reason
            // as above and one more: the wrappings are all C-style or bare, and
            // neither is a line this grammar reads.
            Row {
                grammar: Toml::NAME,
                role: GrammarRole::ReadOnly,
                preserves_trivia: false,
                designates_list_element: false,
                applies_edits: false,
                resolution: Resolution::IndependentOfOrder,
                carries_delimiters: false,
                delimiter_wrappings: Vec::new(),
                merge_by_keys: false,
                merge_bounded_block: false,
            },
        ]
    );
}

/// One line of the published table. A struct rather than a tuple: the columns
/// are named at the place they are compared, so a value landing in the wrong
/// one is a compile error instead of a puzzle in an assertion message.
#[derive(Debug, PartialEq, Eq)]
struct Row {
    grammar: &'static str,
    role: GrammarRole,
    preserves_trivia: bool,
    designates_list_element: bool,
    applies_edits: bool,
    resolution: Resolution,
    carries_delimiters: bool,
    delimiter_wrappings: Vec<Wrapping>,
    merge_by_keys: bool,
    merge_bounded_block: bool,
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

/// A guard, not a scenario: [`Resolution`] cannot be measured from inside
/// this crate — the module header of `capability.rs` says so itself, in the
/// words this test borrows: "a property of whoever reads the document, not
/// of the code that writes it". A test exercising the constant directly would
/// be a tautology. What **is** checkable is the one thing standing between a
/// declared fact and an assumption: the doc comment above every `const
/// RESOLUTION` declaration must quote the claim it rests on, and pin it to
/// something specific enough that what would refute it can be named — a date
/// it was measured on, or a versioned specification that could itself
/// change. `jsonc.rs` and `toml.rs` already carry one each, of the two
/// different forms; this test formalises what they already do rather than
/// inventing a new obligation, and it is meant to catch the day a grammar is
/// added whose `RESOLUTION` is asserted rather than sourced.
#[test]
fn md39_2_every_resolution_declaration_cites_a_dated_or_versioned_source() {
    let sources = crate_sources();
    let needle = "const RESOLUTION: Resolution =";

    // **Every** declaration, not the first of each file. The earlier reading
    // stopped at the first match per file, so a second `const RESOLUTION` in
    // the same file — with no doc comment at all — passed a guard whose name
    // says "every". Measured by mutation on 2026-08-13, at the closure of the
    // family that wrote this guard: adding an unsourced second declaration to
    // `toml.rs` left the suite green.
    let declarations: Vec<(&String, String)> = sources
        .iter()
        .flat_map(|(path, content)| {
            doc_comments_above(content, needle)
                .into_iter()
                .map(move |comment| (path, comment))
        })
        .collect();

    // A guard of the guard: if nothing was found, the loop below passes
    // vacuously and protects nothing — which is exactly the mode this file's
    // other guards of guards exist to close.
    assert!(
        !declarations.is_empty(),
        "no `const RESOLUTION` declaration was found in the crate sources — this guard would \
         protect nothing"
    );

    let unsourced: Vec<String> = declarations
        .iter()
        .filter(|(_, comment)| !is_dated_or_versioned_and_quoted(comment))
        .map(|(path, comment)| {
            format!(
                "{path}: the doc comment above `const RESOLUTION` is not a falsifiable source \
                 — it must quote the claim and pin it to a date or a versioned specification:\n\
                 {comment}"
            )
        })
        .collect();

    assert!(unsourced.is_empty(), "{}", unsourced.join("\n\n"));
}

/// A guard of the guard: the detector below must actually discriminate a
/// sourced claim from a bare one, not merely fail to trip on the two files it
/// happens to be checked against today.
#[test]
fn guard_the_resolution_source_detector_actually_discriminates() {
    let dated_and_quoted = "Measured on 2026-08-06: the host resolves \"by category, not by \
                             position\" (its own documentation, quoted).";
    let versioned_and_quoted =
        "TOML v1.0.0 \u{a7} Keys says \"Defining a key multiple times is invalid\".";
    let bare = "Order plays no part in how this format resolves conflicting keys.";
    let dated_but_not_quoted = "Measured on 2026-08-06 against the host's own behaviour.";
    let quoted_but_not_dated = "The host documentation says \"resolution is by category\".";

    // A line number is not a date. Four consecutive digits used to satisfy the
    // year check, so a comment pointing at "src/toml.rs line 1234" for "the
    // reason" passed while sourcing nothing — measured by mutation on
    // 2026-08-13. The check now wants a year of this century, which is still a
    // check on the **form** of a claim and never on its truth.
    let quoted_with_a_line_number =
        "See src/toml.rs line 1234 for \"the reason\", which is entirely invented.";

    assert!(is_dated_or_versioned_and_quoted(dated_and_quoted));
    assert!(is_dated_or_versioned_and_quoted(versioned_and_quoted));
    assert!(!is_dated_or_versioned_and_quoted(bare));
    assert!(!is_dated_or_versioned_and_quoted(dated_but_not_quoted));
    assert!(!is_dated_or_versioned_and_quoted(quoted_but_not_dated));
    assert!(!is_dated_or_versioned_and_quoted(quoted_with_a_line_number));
}

/// A guard of the guard, on the **reading** rather than on the detector: the
/// scan must return one entry per declaration, not one per file.
///
/// Written after a mutation showed that it did not. A second `const
/// RESOLUTION` added to a source file, carrying no doc comment at all, left
/// `md39_2_every_resolution_declaration_cites_a_dated_or_versioned_source`
/// green — the declaration existed, the reading never saw it, and the guard
/// reported on a set smaller than the one it names. A detector that
/// discriminates perfectly protects nothing if what feeds it is truncated.
#[test]
fn guard_the_resolution_reading_sees_every_declaration_and_not_the_first() {
    let two_declarations = concat!(
        "impl Grammar for First {\n",
        "    /// Measured on 2026-08-06: the host resolves \"by category\".\n",
        "    const RESOLUTION: Resolution = Resolution::IndependentOfOrder;\n",
        "}\n",
        "mod second {\n",
        "    const RESOLUTION: Resolution = Resolution::DependsOnOrder;\n",
        "}\n",
    );

    let comments = doc_comments_above(two_declarations, "const RESOLUTION: Resolution =");

    assert_eq!(
        comments.len(),
        2,
        "the reading must yield one entry per declaration; it yielded {} for two declarations, \
         which is how an unsourced one hides behind a sourced one",
        comments.len()
    );
    assert!(
        is_dated_or_versioned_and_quoted(&comments[0]),
        "the first declaration is sourced and must be recognised as such"
    );
    assert!(
        !is_dated_or_versioned_and_quoted(&comments[1]),
        "the second declaration carries no source at all and must be caught"
    );
}

/// One entry per line of `content` containing `needle`: the contiguous block
/// of `///` lines immediately above it, each with its `///` prefix and the
/// space after it stripped, joined back with newlines. Empty when `needle`
/// does not appear at all.
///
/// **Every occurrence, and that is the whole point of the plural.** This read
/// the first match per file until 2026-08-13, so a second declaration in the
/// same file was invisible to a guard whose name says "every" — a declaration
/// with no doc comment above it produced no entry, and therefore nothing to
/// judge. The failure was found by mutation, not by reading: three readings
/// of this function called it correct.
fn doc_comments_above(content: &str, needle: &str) -> Vec<String> {
    let lines: Vec<&str> = content.lines().collect();
    lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.contains(needle))
        .map(|(index, _)| {
            let mut collected = Vec::new();
            let mut cursor = index;
            while cursor > 0 {
                let Some(text) = lines[cursor - 1].trim().strip_prefix("///") else {
                    break;
                };
                collected.push(text.trim_start());
                cursor -= 1;
            }
            collected.reverse();
            collected.join("\n")
        })
        .collect()
}

/// Whether `comment` is sourced well enough to be falsifiable: it quotes the
/// claim, and pins it to something specific enough that what would refute it
/// can be named — a date it was measured on, or a versioned specification
/// that could itself change.
fn is_dated_or_versioned_and_quoted(comment: &str) -> bool {
    is_quoted(comment) && (contains_a_year(comment) || contains_a_version(comment))
}

/// Whether `comment` quotes something: two or more `"` characters. A source
/// that is not quoted is a paraphrase, and a paraphrase is exactly what
/// drifts from what it once described without anyone noticing.
fn is_quoted(comment: &str) -> bool {
    comment.matches('"').count() >= 2
}

/// Whether `comment` names a calendar year plausible for this project: four
/// consecutive ASCII digits.
fn contains_a_year(comment: &str) -> bool {
    comment
        .as_bytes()
        .windows(4)
        .any(|w| w[0] == b'2' && w[1] == b'0' && w[2].is_ascii_digit() && w[3].is_ascii_digit())
}

/// Whether `comment` names a version of an external specification — `v`
/// immediately followed by a digit, as in "TOML v1.0.0" — or an RFC. This is
/// the form this crate's own sourced claims use in place of a calendar date
/// when what pins the claim is a frozen document rather than a moment
/// measured.
fn contains_a_version(comment: &str) -> bool {
    comment.contains("RFC")
        || comment
            .as_bytes()
            .windows(2)
            .any(|w| (w[0] == b'v' || w[0] == b'V') && w[1].is_ascii_digit())
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
