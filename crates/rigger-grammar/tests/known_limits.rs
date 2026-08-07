//! Limits of pinned libraries, measured and recorded here rather than worked
//! around or passed over in silence.
//!
//! `toml_edit 0.25.13` does not preserve CRLF line endings. The cause is at the
//! source and cannot be worked around by option or by feature: the lexer of
//! `parser/document.rs:252` breaks on `Newline` without recording its span, and
//! `encode.rs:337` refabricates the line separator through `writeln!`, which
//! writes a hard-coded `\n` — no access to the `Decor` allows recovering the
//! lost byte. This is the observable of MD-22 word for word — *after an
//! installation, the comments, the indentation and the line endings its owner
//! had written have disappeared or changed, and nothing announced it* — and
//! MD-22 is what makes the preservation of trivia a condition of a grammar's
//! admission to the `merge` behaviour: TOML is therefore not yet admissible on
//! a CRLF document. The arbitration was opened on 2026-08-05 and belongs to T3,
//! between a fail-closed refusal on CRLF TOML and a normalisation declared
//! acceptable — and the second path cannot be taken without amending MD-22
//! itself.
//!
//! These tests **characterize** that behaviour, they do not endorse it: they pass
//! today because they describe what `toml_edit` actually does. The day
//! `toml_edit` fixes its CRLF support, they go red — that is the signal we want
//! to receive, not a regression to repair in a hurry.

use std::str::FromStr;

use toml_edit::DocumentMut;

/// The same logical content as `tests/corpus/config.toml`, converted to CRLF.
/// Deliberately outside `tests/corpus/`: the conformance property must not see
/// it, and its guard on the size of the corpus (three documents) must stay
/// correct.
const CONFIG_CRLF: &[u8] = include_bytes!("corpus-limits/config-crlf.toml");

#[test]
fn b1_toml_edit_normalises_crlf_to_lf() {
    let text = std::str::from_utf8(CONFIG_CRLF).expect("the fixture must be UTF-8");

    let cr_in = CONFIG_CRLF.iter().filter(|&&b| b == b'\r').count();
    assert_eq!(
        cr_in, 24,
        "the fixture no longer has the expected number of CRLF ({cr_in}; 24 expected) — \
         the test no longer measures what it believes it measures"
    );

    let doc = DocumentMut::from_str(text).expect("TOML parse of the CRLF fixture");
    let output = doc.to_string();
    let output_bytes = output.as_bytes();

    let cr_out = output_bytes.iter().filter(|&&b| b == b'\r').count();
    assert_eq!(
        cr_out, 0,
        "a \\r survived the round trip ({cr_out} out of {cr_in} on input) — \
         the limit documented here would no longer be the real behaviour of toml_edit"
    );

    assert_eq!(
        CONFIG_CRLF.len() - output_bytes.len(),
        cr_in,
        "the byte loss no longer matches exactly the number of \\r removed \
         (input {} bytes, output {} bytes)",
        CONFIG_CRLF.len(),
        output_bytes.len()
    );

    // The bound on the loss: beyond the line endings, the output must be
    // identical to `tests/corpus/config.toml` — the same trivia, in LF, already
    // checked byte-identical by `conformance.rs`. Any other difference would be a
    // loss not documented here, and that is the information T3 needs: the loss is
    // confined to the single dimension of line endings.
    let expected_lf = include_bytes!("corpus/config.toml");
    assert_eq!(
        output_bytes, expected_lf,
        "beyond the line endings, the output diverges from tests/corpus/config.toml: \
         the loss is no longer confined to the CRLF"
    );
}

#[test]
fn b1_toml_edit_adds_a_missing_final_newline() {
    let with_newline = include_str!("corpus/config.toml");
    let without_newline = with_newline
        .strip_suffix('\n')
        .expect("tests/corpus/config.toml must end with a \\n");
    assert!(
        !without_newline.ends_with('\n'),
        "the input of this test must not end with a newline, otherwise it tests nothing"
    );

    let doc = DocumentMut::from_str(without_newline).expect("TOML parse with no final newline");
    let output = doc.to_string();

    assert!(
        output.ends_with('\n'),
        "toml_edit did not add the expected final newline — the limit documented here has changed"
    );
    assert_eq!(
        output.len(),
        without_newline.len() + 1,
        "the output ({} bytes) should differ from the input ({} bytes) only by the added final \\n",
        output.len(),
        without_newline.len()
    );
    assert_eq!(
        output.as_bytes()[..without_newline.len()],
        *without_newline.as_bytes(),
        "beyond the added \\n, the content diverged — the loss would no longer be confined to the \
         final newline"
    );
}
