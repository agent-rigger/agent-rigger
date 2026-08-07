//! The bounded block: its marker, its single recogniser, and the post-condition
//! of removal. Scenarios of `docs/specs/socle-neuf/requirements.md` § C3 and
//! § C4.
//!
//! **The four wrapping variants are written by hand here, on purpose.** Asking
//! the crate to render them would make this file agree with the implementation
//! by construction, and a recogniser that only ever meets its own output is a
//! recogniser nobody measured. What is written below is the syntax a document
//! carries, stated independently.
//!
//! **The mutation trial is the reason the rest of this file is worth
//! anything.** `c3_disabling_one_recognition_branch_makes_a_wrapping_fall`
//! re-runs the assertion of the four-wrapping test with one branch of the
//! recogniser switched off, and demands that the wrappings that branch serves
//! stop being recognised. If a second read path covered them, they would keep
//! classifying as `Unique` under mutation and that test would go red — which is
//! exactly the point: it is the one test here whose object is to check that the
//! others measure something.

use rigger_grammar::marker::{
    place, read, read_with, remove, remove_by, Branch, Classification, Marker, PlaceError, Placed,
    Pose, Reading, RemoveError, Wrapping,
};
use rigger_grammar::SemanticValue;

/// The address the trace records for the document these scenarios write in.
/// It is what a refusal names alongside a value, and it is never a line number.
const ADDRESS: &str = "AGENTS.md";

const PROVENANCE: &str = "github.com/acme/rig";
const HOMONYM_PROVENANCE: &str = "gitlab.com/zenith/rig";
/// The entry identifier two independent authors will both choose. That
/// collision is the whole subject of C4.
const ENTRY: &str = "context/agents";

fn marker() -> Marker {
    Marker::new(PROVENANCE, ENTRY)
}

fn homonym() -> Marker {
    Marker::new(HOMONYM_PROVENANCE, ENTRY)
}

/// The four wrappings, written out. A delimiter is a line of the document, and
/// these are the four shapes a document can carry it in.
fn wrap(wrapping: Wrapping, token: &str) -> String {
    match wrapping {
        Wrapping::LineComment => format!("// {token}\n"),
        Wrapping::BlockCommentInline => format!("/* {token} */\n"),
        Wrapping::BlockCommentSpanning => format!("/*\n{token}\n*/\n"),
        Wrapping::Bare => format!("{token}\n"),
    }
}

/// The same document in four wrappings: two values of the user outside the
/// bounds, one value of the product inside.
fn document(wrapping: Wrapping) -> String {
    let marker = marker();
    let mut source = String::from("docs/a.md\n");
    source.push_str(&wrap(wrapping, &marker.open()));
    source.push_str("docs/posed.md\n");
    source.push_str(&wrap(wrapping, &marker.close()));
    source.push_str("docs/b.md\n");
    source
}

/// What the registry recorded for the block of [`document`].
fn trace() -> rigger_grammar::marker::BlockTrace {
    rigger_grammar::marker::BlockTrace::new(marker(), ADDRESS, ["docs/posed.md"])
}

fn texts(values: &[SemanticValue]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
}

/// The classification each wrapping gets under a given set of recognition
/// branches. This is the assertion of the four-wrapping test, expressed as a
/// value so the mutation trial can re-run it with a branch switched off.
fn classifications(branches: &[Branch]) -> Vec<(Wrapping, Classification)> {
    Wrapping::ALL
        .iter()
        .map(|&wrapping| {
            let reading = read_with(&document(wrapping), ADDRESS, &marker(), branches);
            (wrapping, reading.recognition.classification())
        })
        .collect()
}

#[test]
fn c3_the_four_wrappings_yield_one_classification_and_one_owned_passage() {
    let readings: Vec<(Wrapping, Reading)> = Wrapping::ALL
        .iter()
        .map(|&wrapping| (wrapping, read(&document(wrapping), ADDRESS, &marker())))
        .collect();

    for (wrapping, reading) in &readings {
        assert_eq!(
            reading.recognition.classification(),
            Classification::Unique,
            "{wrapping:?} must classify as the other three do"
        );
        assert_eq!(
            texts(&reading.inside),
            [format!("{ADDRESS} = \"docs/posed.md\"")],
            "{wrapping:?} must own the same passage as the other three"
        );
        assert_eq!(
            texts(&reading.outside),
            [
                format!("{ADDRESS} = \"docs/a.md\""),
                format!("{ADDRESS} = \"docs/b.md\""),
            ],
            "{wrapping:?} must leave the same values outside its bounds"
        );
    }

    let (_, first) = &readings[0];
    for (wrapping, reading) in &readings[1..] {
        assert_eq!(
            texts(&reading.inside),
            texts(&first.inside),
            "{wrapping:?} owns a different passage"
        );
        assert_eq!(
            texts(&reading.outside),
            texts(&first.outside),
            "{wrapping:?} leaves different values outside"
        );
    }
}

#[test]
fn c3_disabling_one_recognition_branch_makes_a_wrapping_fall() {
    let whole = classifications(Branch::ALL);
    assert!(
        whole
            .iter()
            .all(|(_, classification)| *classification == Classification::Unique),
        "the trial only means something against a green suite: {whole:?}"
    );

    for &disabled in Branch::ALL {
        let remaining: Vec<Branch> = Branch::ALL
            .iter()
            .copied()
            .filter(|branch| *branch != disabled)
            .collect();
        let mutated = classifications(&remaining);

        let mut fallen = 0;
        for (wrapping, classification) in &mutated {
            if wrapping.branch() == disabled {
                assert_eq!(
                    *classification,
                    Classification::Absent,
                    "{wrapping:?} still classifies as `Unique` with the {disabled:?} branch \
                     switched off — a second read path covers it, so the four-wrapping test does \
                     not measure that branch"
                );
                fallen += 1;
            } else {
                assert_eq!(
                    *classification,
                    Classification::Unique,
                    "{wrapping:?} fell with the {disabled:?} branch switched off, which it does \
                     not use — the branches are not exclusive"
                );
            }
        }
        assert!(
            fallen > 0,
            "no wrapping falls when the {disabled:?} branch is switched off, so no test in this \
             file measures it"
        );
    }
}

#[test]
fn c3_the_nominal_removal_leaves_the_values_of_the_user_intact() {
    for &wrapping in Wrapping::ALL {
        let source = document(wrapping);
        let removed = remove(&source, &trace()).expect("the block is there and is separable");

        assert!(
            removed.rendered.contains("docs/a.md"),
            "{wrapping:?} lost a value of the user"
        );
        assert!(
            removed.rendered.contains("docs/b.md"),
            "{wrapping:?} lost a value of the user"
        );
        assert!(
            !removed.rendered.contains("docs/posed.md"),
            "{wrapping:?} left the posed value behind"
        );
        assert!(
            !removed.rendered.contains(&marker().open())
                && !removed.rendered.contains(&marker().close()),
            "{wrapping:?} left a delimiter behind"
        );
        assert_eq!(
            read(&removed.rendered, ADDRESS, &marker())
                .recognition
                .classification(),
            Classification::Absent,
            "{wrapping:?} still recognises a passage after removal"
        );
    }
}

#[test]
fn c3_a_removal_that_destroys_a_value_outside_the_trace_fails_on_the_output() {
    let source = document(Wrapping::LineComment);

    // An excision that takes one line too many. The bounds it is handed are the
    // right ones; it is the write that is wrong, which is the only case the
    // post-condition exists for.
    let error = remove_by(&source, &trace(), |source, bounds| {
        let mut rendered = String::from(&source[..bounds.start]);
        rendered.push_str(&source[bounds.end..]);
        rendered.replace("docs/a.md\n", "")
    })
    .expect_err("the write destroyed a value the trace does not record");

    match &error {
        RemoveError::ValuesLost { lost, .. } => {
            assert_eq!(texts(lost), [format!("{ADDRESS} = \"docs/a.md\"")]);
        }
        other => panic!("the refusal must name the value that disappeared, got {other:?}"),
    }
    let message = error.to_string();
    assert!(
        message.contains("docs/a.md") && message.contains(ADDRESS),
        "the refusal must name the value and its path: {message}"
    );
}

#[test]
fn c3_the_removal_failure_is_not_deduced_from_the_input_checks() {
    let source = document(Wrapping::LineComment);

    // Every input check succeeds: the passage is recognised, it is unique, and
    // every value the trace records lives inside it.
    let reading = read(&source, ADDRESS, &marker());
    assert_eq!(reading.recognition.classification(), Classification::Unique);
    for recorded in trace().recorded_values() {
        assert!(
            reading.inside.contains(&recorded),
            "input check: {recorded} must be inside the bounds"
        );
    }

    // And the write nevertheless destroys a value outside the trace. The
    // failure is therefore raised by reading the output back, never by the
    // success of what precedes.
    let error = remove_by(&source, &trace(), |source, bounds| {
        let mut rendered = String::from(&source[..bounds.start]);
        rendered.push_str(&source[bounds.end..]);
        rendered.replace("docs/b.md\n", "")
    })
    .expect_err("input checks passing says nothing about what the write did");

    assert!(
        error.to_string().contains("docs/b.md"),
        "the refusal must name what the write destroyed: {error}"
    );
}

#[test]
fn c4_two_homonymous_catalogues_do_not_share_a_marker() {
    assert_ne!(
        marker().open(),
        homonym().open(),
        "two catalogues carrying the same entry identifier must not write the same delimiter"
    );

    let mut source = String::from("docs/a.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker().open()));
    source.push_str("acme.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker().close()));
    source.push_str(&wrap(Wrapping::LineComment, &homonym().open()));
    source.push_str("zenith.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &homonym().close()));
    source.push_str("docs/b.md\n");

    let removed =
        remove(&source, &trace_of(marker(), "acme.md")).expect("the first block is there");

    assert!(
        !removed.rendered.contains("acme.md"),
        "the first block was not removed"
    );
    assert!(
        removed.rendered.contains("zenith.md"),
        "removing the first block took the values of the second"
    );
    assert_eq!(
        read(&removed.rendered, ADDRESS, &homonym())
            .recognition
            .classification(),
        Classification::Unique,
        "the block of the second catalogue must still be recognised whole"
    );
}

fn trace_of(marker: Marker, value: &str) -> rigger_grammar::marker::BlockTrace {
    rigger_grammar::marker::BlockTrace::new(marker, ADDRESS, [value])
}

#[test]
fn c4_the_marker_names_its_provenance_and_its_entry_in_clear_and_separated() {
    let open = marker().open();

    assert!(
        open.contains(PROVENANCE),
        "the provenance must be readable as written: {open}"
    );
    assert!(
        open.contains(ENTRY),
        "the entry identifier must be readable as written: {open}"
    );

    let provenance_at = open.find(PROVENANCE).expect("provenance is present");
    let entry_at = open.rfind(ENTRY).expect("entry is present");
    assert!(
        provenance_at < entry_at,
        "the two fields must be separated, not run together: {open}"
    );
    assert!(
        open[provenance_at + PROVENANCE.len()..entry_at].contains(char::is_whitespace),
        "the two fields must be separated by a space: {open}"
    );
}

#[test]
fn c4_a_marker_with_no_trace_makes_the_pose_refuse_by_naming_it() {
    // A document already carrying a marker of the product, for which the
    // registry holds nothing.
    let source = document(Wrapping::LineComment);
    let stranger = Marker::new("gitlab.com/other/rig", "context/other");

    let error = place(
        &source,
        &Pose {
            marker: &stranger,
            address: ADDRESS,
            roots: &["/home/u/.config"],
            traced: std::slice::from_ref(&stranger),
            body: &["docs/other.md"],
            wrapping: Wrapping::LineComment,
        },
    )
    .expect_err("a marker with no trace must make the pose refuse");

    match &error {
        PlaceError::UntracedMarker { marker: found, .. } => assert_eq!(*found, marker()),
        other => panic!("the refusal must name the marker it found, got {other:?}"),
    }
    let message = error.to_string();
    assert!(
        message.contains(PROVENANCE) && message.contains(ENTRY),
        "the refusal must name the marker it found: {message}"
    );
    assert!(
        !message.contains("adopt"),
        "the marker is never adopted in passing: {message}"
    );
}

#[test]
fn c4_two_roots_designating_the_same_document_make_the_pose_refuse_by_naming_both() {
    let error = place(
        "docs/a.md\n",
        &Pose {
            marker: &marker(),
            address: ADDRESS,
            roots: &["/home/u/.config/rig", "/srv/shared/rig"],
            traced: &[],
            body: &["docs/posed.md"],
            wrapping: Wrapping::LineComment,
        },
    )
    .expect_err("two distinct roots on one document must make the pose refuse");

    let message = error.to_string();
    assert!(
        message.contains("/home/u/.config/rig") && message.contains("/srv/shared/rig"),
        "the refusal must name both roots: {message}"
    );
}

#[test]
fn c4_a_pose_writes_a_block_carrying_the_identity_of_the_pose() {
    let Placed { rendered, trace } = place(
        "docs/a.md\ndocs/b.md\n",
        &Pose {
            marker: &marker(),
            address: ADDRESS,
            roots: &["/home/u/.config/rig"],
            traced: &[],
            body: &["docs/posed.md"],
            wrapping: Wrapping::LineComment,
        },
    )
    .expect("nothing stands in the way of this pose");

    let reading = read(&rendered, ADDRESS, &marker());
    assert_eq!(reading.recognition.classification(), Classification::Unique);
    assert_eq!(
        texts(&reading.inside),
        [format!("{ADDRESS} = \"docs/posed.md\"")]
    );
    assert_eq!(
        texts(&reading.outside),
        [
            format!("{ADDRESS} = \"docs/a.md\""),
            format!("{ADDRESS} = \"docs/b.md\""),
        ]
    );

    let removed = remove(&rendered, &trace).expect("what was posed is removable");
    assert_eq!(removed.rendered, "docs/a.md\ndocs/b.md\n");
}

#[test]
fn c1_a_block_posed_in_a_document_in_crlf_is_written_in_crlf() {
    let source = "docs/a.md\r\ndocs/b.md\r\n";
    let Placed { rendered, trace } = place(
        source,
        &Pose {
            marker: &marker(),
            address: ADDRESS,
            roots: &["/home/u/.config/rig"],
            traced: &[],
            body: &["docs/posed.md"],
            wrapping: Wrapping::LineComment,
        },
    )
    .expect("nothing stands in the way of this pose");

    assert_eq!(
        rendered.matches('\n').count(),
        rendered.matches("\r\n").count(),
        "a line ending in LF was written into a document in CRLF: {rendered:?}"
    );
    assert_eq!(
        remove(&rendered, &trace)
            .expect("what was posed is removable")
            .rendered,
        source,
        "removal must give back the bytes from before"
    );
}

#[test]
fn guard_the_four_wrappings_are_four_distinct_documents() {
    let documents: Vec<String> = Wrapping::ALL.iter().map(|&w| document(w)).collect();
    for (rank, left) in documents.iter().enumerate() {
        for right in &documents[rank + 1..] {
            assert_ne!(
                left, right,
                "two wrappings produce the same bytes, so the four-wrapping test measures one \
                 document several times"
            );
        }
    }
}
