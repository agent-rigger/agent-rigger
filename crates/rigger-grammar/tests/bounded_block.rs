//! The bounded block: its marker, its single recogniser, and the post-condition
//! of removal. C3 asks for **one recogniser and one only**, and for a removal
//! whose post-condition is symmetric to it: what was posed is gone, and nothing
//! its owner wrote moved. C4 asks that the marker of a block **derive from the
//! recorded identity** of whoever posed it, so that two catalogues never share
//! one and neither can remove the other's block.
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
    place, place_by, read, read_with, remove, remove_by, Branch, Classification, Marker,
    PlaceError, Placed, Pose, Reading, RemoveError, Wrapping, Written,
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

/// A write that does not touch the source at all destroys no value and
/// disturbs no neighbour, so neither of those two post-conditions can catch
/// it — the only property left that tells this apart from a real removal is
/// reading the passage back and finding it still there.
#[test]
fn c3_a_removal_whose_write_left_the_passage_recognised_is_reported_still_present() {
    let source = document(Wrapping::LineComment);

    let error = remove_by(&source, &trace(), |source, _bounds| source.to_string())
        .expect_err("a write that leaves the passage recognised must not be reported as removed");

    match &error {
        RemoveError::StillPresent { marker: found, .. } => assert_eq!(*found, marker()),
        other => panic!("the refusal must report the passage as still present, got {other:?}"),
    }
    let message = error.to_string();
    assert!(
        message.contains(ADDRESS),
        "the refusal must name the document: {message}"
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
            posed: None,
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
            posed: None,
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
            posed: None,
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
            posed: None,
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

/// The documents this shape has an object on are **text** files, and `//` is
/// not comment syntax in an instruction file — it is two characters a person
/// typed. A line the lexer happens to classify as a comment is therefore a
/// value of whoever wrote it, exactly like any other line, and removal owes it
/// the same post-condition.
#[test]
fn c3_a_removal_that_destroys_a_commented_line_of_the_user_fails_on_the_output() {
    let marker = marker();
    let note = "// NOTE: I need this, do not delete";

    let mut source = String::from("docs/a.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker.open()));
    source.push_str("docs/posed.md\n");
    source.push_str(note);
    source.push('\n');
    source.push_str(&wrap(Wrapping::LineComment, &marker.close()));
    source.push_str("docs/b.md\n");

    let reading = read(&source, ADDRESS, &marker);
    assert!(
        texts(&reading.inside).contains(&format!("{ADDRESS} = {note:?}")),
        "the line is a value of its author, whatever the lexer calls it: {:?}",
        texts(&reading.inside)
    );

    // The production path, not the seam: this is what a real removal does.
    let error = remove(&source, &trace()).expect_err(
        "the write destroyed a line the trace does not record, so the removal must refuse",
    );
    match &error {
        RemoveError::ValuesLost { lost, .. } => {
            assert_eq!(texts(lost), [format!("{ADDRESS} = {note:?}")]);
        }
        other => panic!("the refusal must name the line that disappeared, got {other:?}"),
    }
}

/// The same blindness, on the other side of the bounds and under the other
/// comment syntax: a line enclosed in `/* … */` that carries no delimiter is
/// read by nobody, so no post-condition can see it go.
#[test]
fn c3_a_line_enclosed_in_a_block_comment_is_a_value_of_its_author() {
    let marker = marker();
    let note = "my own note";

    let mut source = String::from("docs/a.md\n/*\n");
    source.push_str(note);
    source.push_str("\n*/\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker.open()));
    source.push_str("docs/posed.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker.close()));
    source.push_str("docs/b.md\n");

    let reading = read(&source, ADDRESS, &marker);
    assert!(
        texts(&reading.outside).contains(&format!("{ADDRESS} = {note:?}")),
        "a line the product did not write is a value wherever the lexer files it: {:?}",
        texts(&reading.outside)
    );

    let error = remove_by(&source, &trace(), |source, bounds| {
        let mut rendered = String::from(&source[..bounds.start]);
        rendered.push_str(&source[bounds.end..]);
        rendered.replace("my own note\n", "")
    })
    .expect_err("the write destroyed a line the trace does not record");
    assert!(
        error.to_string().contains(note),
        "the refusal must name what the write destroyed: {error}"
    );
}

/// Indentation is the norm in a fragment of an instruction file — nested
/// lists, code blocks. If the reading and the trace do not normalise a line the
/// same way, the block cannot subtract from itself and becomes permanently
/// unremovable, while the product accuses itself of a destruction that never
/// happened.
#[test]
fn c3_a_body_line_carrying_indentation_stays_removable() {
    let source = "docs/a.md\n";
    let Placed { rendered, trace } = place(
        source,
        &Pose {
            marker: &marker(),
            address: ADDRESS,
            roots: &["/home/u/.config/rig"],
            traced: &[],
            posed: None,
            body: &["# Rules", "  - run the tests"],
            wrapping: Wrapping::LineComment,
        },
    )
    .expect("nothing stands in the way of this pose");

    let removed = remove(&rendered, &trace).expect("what was posed must be removable");
    assert_eq!(
        removed.rendered, source,
        "removal must give back the bytes from before"
    );
}

/// A marker the recogniser cannot read back out of the document it was written
/// into delimits nothing: the block is invisible to every later read, so it is
/// unremovable, and every further pose appends another copy of it.
#[test]
fn c4_a_marker_the_document_cannot_carry_makes_the_pose_refuse() {
    // The whitespace `parse_token` rejects, and a `*/` that closes the very
    // comment meant to carry the token. Both are illegal for the same reason,
    // and neither is a character on a list: the recogniser cannot read them.
    let cases = [
        (Marker::new(PROVENANCE, "context agents"), Wrapping::Bare),
        (
            Marker::new(PROVENANCE, "context*/agents"),
            Wrapping::BlockCommentInline,
        ),
    ];

    for (marker, wrapping) in cases {
        let error = place(
            "docs/a.md\n",
            &Pose {
                marker: &marker,
                address: ADDRESS,
                roots: &["/home/u/.config/rig"],
                traced: &[],
                posed: None,
                body: &["docs/posed.md"],
                wrapping,
            },
        )
        .expect_err("a marker the document cannot carry must make the pose refuse");

        assert!(
            error.to_string().contains(marker.entry()),
            "the refusal must name the marker it could not read back: {error}"
        );
    }
}

/// A delimiter carries no value, so the value post-condition cannot see one
/// disappear. Bounds that straddle the delimiter of another catalogue therefore
/// leave that block unbalanced — unremovable, its bytes owned by nobody — and
/// nothing goes red. That is the damage C4 names, and it is checked on the
/// output like everything else.
#[test]
fn c4_a_removal_does_not_take_the_delimiter_of_another_catalogue() {
    let (first, second) = (marker(), homonym());

    // The interleaving an owner produces by moving a block around.
    let mut source = String::from("docs/a.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &first.open()));
    source.push_str("acme.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &second.open()));
    source.push_str(&wrap(Wrapping::LineComment, &first.close()));
    source.push_str("zenith.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &second.close()));

    assert_eq!(
        read(&source, ADDRESS, &second).recognition.classification(),
        Classification::Unique,
        "the second block must be whole before the removal, or this measures nothing"
    );

    let error = remove(&source, &trace_of(first, "acme.md"))
        .expect_err("the bounds straddle the opening delimiter of the second catalogue");
    let message = error.to_string();
    assert!(
        message.contains(HOMONYM_PROVENANCE),
        "the refusal must name the block it would have broken: {message}"
    );
}

/// `marker.rs:57` promises that **both** writes compare the delimiters of the
/// other markers, before and after — this is the `place` half of that promise,
/// symmetric to `c4_a_removal_does_not_take_the_delimiter_of_another_catalogue`
/// just above. An update rewrites its own bounds exactly like a removal
/// excises them, so the same interleaving that takes a neighbour's opening
/// delimiter with it on removal takes it with it here too.
#[test]
fn c4_a_pose_does_not_take_the_delimiter_of_another_catalogue() {
    let (first, second) = (marker(), homonym());
    let traced = [first.clone(), second.clone()];

    // The same interleaving as the removal counterpart: the second catalogue's
    // opening delimiter sits inside the bounds an update to the first would
    // rewrite.
    let mut source = String::from("docs/a.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &first.open()));
    source.push_str("acme.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &second.open()));
    source.push_str(&wrap(Wrapping::LineComment, &first.close()));
    source.push_str("zenith.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &second.close()));

    assert_eq!(
        read(&source, ADDRESS, &second).recognition.classification(),
        Classification::Unique,
        "the second block must be whole before the pose, or this measures nothing"
    );

    // An update to the first block, rewriting its interior to the same value
    // it already carries — so that no value post-condition fires first, and
    // the neighbour check is the one measured here.
    let error = place(
        &source,
        &Pose {
            marker: &first,
            address: ADDRESS,
            roots: &["/home/u/.config/rig"],
            traced: &traced,
            posed: Some(&trace_of(first.clone(), "acme.md")),
            body: &["acme.md"],
            wrapping: Wrapping::LineComment,
        },
    )
    .expect_err("the bounds straddle the opening delimiter of the second catalogue");

    match &error {
        PlaceError::NeighbourBroken { neighbour, .. } => assert_eq!(*neighbour, second),
        other => panic!("the refusal must name the neighbour it would have broken, got {other:?}"),
    }
    let message = error.to_string();
    assert!(
        message.contains(HOMONYM_PROVENANCE),
        "the refusal must name the block it would have broken: {message}"
    );
}

/// The two paths must judge the same line the same way. Removal calls a line
/// the owner added inside the bounds a value of the user and refuses; the
/// update path of a pose was overwriting it without looking.
#[test]
fn c4_an_update_does_not_destroy_what_the_owner_wrote_inside_the_bounds() {
    let marker = marker();
    let note = "docs/user-note.md";

    let mut source = String::from("docs/a.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker.open()));
    source.push_str("docs/posed.md\n");
    source.push_str(note);
    source.push('\n');
    source.push_str(&wrap(Wrapping::LineComment, &marker.close()));

    let update = Pose {
        marker: &marker,
        address: ADDRESS,
        roots: &["/home/u/.config/rig"],
        traced: std::slice::from_ref(&marker),
        posed: Some(&trace()),
        body: &["docs/posed.md"],
        wrapping: Wrapping::LineComment,
    };

    let error = place(&source, &update).expect_err(
        "the update would erase a line the owner wrote, which removal refuses on this same document",
    );
    match &error {
        PlaceError::ValuesLost { lost, .. } => {
            assert_eq!(texts(lost), [format!("{ADDRESS} = {note:?}")]);
        }
        other => panic!("the refusal must name the line it would have erased, got {other:?}"),
    }

    // The same removal on the same document refuses in the same terms. That
    // agreement is the point: one line, one verdict.
    let refused = remove(&source, &trace()).expect_err("removal refuses for the same reason");
    assert!(
        refused.to_string().contains(note),
        "the two paths must judge this line the same way: {refused}"
    );

    // And an update that only rewrites what the product itself posed goes
    // through, or the check above would just be a way of never updating.
    let placed = place(
        &document(Wrapping::LineComment),
        &Pose {
            body: &["docs/posed.md", "docs/added.md"],
            ..update
        },
    )
    .expect("rewriting the interior the product wrote is what an update is");
    assert!(placed.rendered.contains("docs/added.md"));
}

/// No fixture in this file writes a closing delimiter before its opening one
/// — every document above is built by [`document`], which always emits the
/// pair in order. This is the fixture that exercises the branch of `classify`
/// which refuses that inversion.
#[test]
fn c3_a_document_whose_closing_delimiter_precedes_its_opening_is_unbalanced() {
    let marker = marker();
    let mut source = String::from("docs/a.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker.close()));
    source.push_str("docs/posed.md\n");
    source.push_str(&wrap(Wrapping::LineComment, &marker.open()));
    source.push_str("docs/b.md\n");

    let reading = read(&source, ADDRESS, &marker);
    assert_eq!(
        reading.recognition.classification(),
        Classification::Unbalanced,
        "a closing delimiter that precedes the opening one must not be read as a bounded passage"
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

/// A document whose last line carries **no terminator** is what every editor
/// that does not add one produces, and it forces the pose to write one: without
/// it the opening delimiter would be glued to the last line its owner wrote.
///
/// C1 requires that, outside what the trace records, the document come back
/// byte for byte. That terminator is outside the block, so unless the trace
/// carries it, removal cannot take it back and the document comes back one line
/// ending **longer** than it went in. Nothing is lost, so no post-condition that
/// looks for a missing value can see it — which is why this went unnoticed.
///
/// Both families of line ending are exercised, because the terminator written
/// must be the document's own: writing LF into a document in CRLF is the very
/// reformatting C1 forbids, applied to the bytes the product adds.
#[test]
fn c1_a_pose_on_a_document_with_no_final_terminator_adds_no_byte_the_trace_does_not_carry() {
    for source in ["docs/a.md\ndocs/b.md", "docs/a.md\r\ndocs/b.md"] {
        let Placed { rendered, trace } = place(
            source,
            &Pose {
                marker: &marker(),
                address: ADDRESS,
                roots: &["/home/u/.config/rig"],
                traced: &[],
                posed: None,
                body: &["docs/posed.md"],
                wrapping: Wrapping::LineComment,
            },
        )
        .expect("nothing stands in the way of this pose");

        assert!(
            rendered.starts_with(source),
            "the pose must leave the bytes it found where they were: {rendered:?}"
        );
        assert_eq!(
            rendered.matches('\n').count(),
            if source.contains("\r\n") {
                rendered.matches("\r\n").count()
            } else {
                rendered.matches('\n').count()
            },
            "the terminator written must be the document's own: {rendered:?}"
        );

        assert_eq!(
            remove(&rendered, &trace)
                .expect("what was posed is removable")
                .rendered,
            source,
            "removal must give back the bytes from before, and give back no others"
        );
    }
}

/// The same document, posed then **updated** then removed. The terminator the
/// first pose had to add is still outside the second block, so the trace the
/// update yields owes it too — otherwise the leak survives an update and only
/// shows at the removal that follows it.
#[test]
fn c1_an_update_of_a_block_posed_without_a_final_terminator_still_gives_the_bytes_back() {
    let source = "docs/a.md\r\ndocs/b.md";
    let mine = marker();
    let pose = Pose {
        marker: &mine,
        address: ADDRESS,
        roots: &["/home/u/.config/rig"],
        traced: &[],
        posed: None,
        body: &["docs/posed.md"],
        wrapping: Wrapping::LineComment,
    };
    let first = place(source, &pose).expect("nothing stands in the way of this pose");

    let updated = place(
        &first.rendered,
        &Pose {
            traced: std::slice::from_ref(&mine),
            posed: Some(&first.trace),
            body: &["docs/posed.md", "docs/added.md"],
            ..pose
        },
    )
    .expect("rewriting the interior the product wrote is what an update is");

    assert_eq!(
        remove(&updated.rendered, &updated.trace)
            .expect("what was posed is removable")
            .rendered,
        source,
        "an update must not lose the account of what the first pose added"
    );
}

/// The post-condition of C1 in its general form: outside the bytes any trace
/// accounts for, the rendering must be the source byte for byte.
///
/// **A post-condition no test can redden is a promise, not a measurement**, and
/// that is the whole reason `place_by` exists. The write handed in here passes
/// every input check — the marker is traced, the roots agree, the block reads
/// back as one passage, no value disappears, no neighbour is broken — and adds
/// a byte outside the block while declaring nothing. That is the shape of the
/// defect this post-condition was written for: a terminator the pose wrote and
/// the trace did not carry, which removal could not take back.
///
/// It also states what the value comparisons structurally cannot: the byte
/// added here is a bare line terminator, which is **no value at all**, so no
/// subtraction of values before from values after could ever see it.
#[test]
fn c1_a_write_that_adds_a_byte_outside_the_trace_makes_the_pose_abort() {
    let source = "docs/a.md\ndocs/b.md\n";
    let pose = Pose {
        marker: &marker(),
        address: ADDRESS,
        roots: &["/home/u/.config/rig"],
        traced: &[],
        posed: None,
        body: &["docs/posed.md"],
        wrapping: Wrapping::LineComment,
    };

    // The same writing production performs, plus one byte nobody records.
    let error = place_by(source, &pose, |source, bounds, block| {
        assert!(bounds.is_none(), "this document carries no block yet");
        Written {
            document: format!("{source}{block}\n"),
            added_terminator: String::new(),
        }
    })
    .expect_err("a byte written outside every trace must make the pose abort");

    match &error {
        PlaceError::WroteOutsideTrace { was, now, .. } => {
            assert_eq!(
                (*was, *now),
                (source.len(), source.len() + 1),
                "the refusal must count the bytes left outside the trace on both sides"
            );
        }
        other => panic!("the refusal must name the write, got {other:?}"),
    }
    assert!(
        error.to_string().contains(ADDRESS),
        "the refusal must name the document: {error}"
    );

    // And the writing production actually performs goes through the same
    // check, or the test above would only be measuring a rejection of
    // everything.
    place(source, &pose).expect("what production writes accounts for every byte it adds");
}
