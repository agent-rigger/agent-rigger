//! The post-condition of a **removal**, on the document the removal produced.
//!
//! C3 — after a removal, a post-condition re-reads the document and aborts if
//! something the recorded trace does not name has disappeared, naming it. The
//! pose has carried its own post-condition since the grammar crate existed; the
//! removal had none, and the gap is not symmetric decoration.
//!
//! **Why the pose's proof does not cover the removal.** A pose proves itself
//! reversible against the document it read, at the moment it read it. Between
//! that moment and the removal, the owner writes — and the host that is served
//! rewrites these documents routinely. What a trace excises at removal time is
//! therefore a passage nobody has proved anything about, and the only place the
//! damage shows is the output.

use std::path::{Path, PathBuf};

use rigger_grammar::{Edit, Inverse, MergeError, Value};
use rigger_plan::{behaviour, BehaviourError, BehaviourName, Fragment, GrammarName, Subject};

/// A settings document with hostile trivia: a tab indentation, and a comment on
/// a key the product does not touch.
const DOCUMENT: &str = concat!(
    "{\n",
    "\t// the owner wrote this\n",
    "\t\"model\": \"opus\",\n",
    "\t\"theme\": \"dark\"\n",
    "}\n",
);

fn address() -> PathBuf {
    Path::new("settings.json").to_path_buf()
}

fn fragment() -> Fragment {
    Fragment::Grammar {
        grammar: GrammarName::Jsonc,
        edit: Edit::keys(&[], [("statusLine", Value::text("rigger"))]),
    }
}

/// Poses the fragment into `DOCUMENT` and hands back what a registry would
/// record: the document as written, and the trace that undoes it.
fn posed() -> (String, rigger_plan::Trace) {
    let posed = behaviour(BehaviourName::Merge)
        .pose(
            Subject {
                address: &address(),
                observed: Some(DOCUMENT),
            },
            &fragment(),
        )
        .expect("the pose must succeed");
    (posed.contents, posed.trace)
}

/// Replays `trace` backwards on `document`, as a removal does.
fn remove(document: &str, trace: &rigger_plan::Trace) -> Result<String, BehaviourError> {
    behaviour(BehaviourName::Merge)
        .undo(
            Subject {
                address: &address(),
                observed: Some(document),
            },
            trace,
        )
        .map(|undone| undone.contents)
}

#[test]
fn c3_a_removal_that_destroys_a_comment_of_its_owner_fails_on_the_output() {
    // GIVEN a posed key that its owner has since annotated. The host this
    // product serves rewrites these documents itself, and their owners edit
    // them: a line that carries a pose and a comment is the ordinary case, not
    // the corner.
    let (written, trace) = posed();
    let annotated = written.replace(
        "\"statusLine\": \"rigger\"",
        "\"statusLine\": \"rigger\" // the owner annotated this",
    );
    assert_ne!(
        annotated, written,
        "the annotation must land on the document"
    );
    assert_eq!(
        trace,
        rigger_plan::Trace::Grammar {
            grammar: GrammarName::Jsonc,
            inverse: Inverse::Keys {
                path: Vec::new(),
                added: vec!["statusLine".to_string()],
                replaced: Vec::new(),
            },
        },
        "the trace names the key and nothing else — that is what makes the annotation unnamed"
    );

    // WHEN the removal runs. Every input check passes: the document parses, the
    // trace is well formed, the key it names is there. The damage is only
    // observable on the output, which is the whole reason the post-condition
    // reads the rendering back rather than trusting what came in.
    let refusal = remove(&annotated, &trace)
        .expect_err("a comment of the owner left the document without anything going red");

    // THEN the refusal names the comment it would have destroyed, and no
    // document comes back to be written.
    match &refusal {
        BehaviourError::Merge(MergeError::RemovalLostComments { grammar, lost }) => {
            assert_eq!(*grammar, "jsonc");
            assert_eq!(lost, &vec!["// the owner annotated this".to_string()]);
        }
        other => panic!("the refusal does not come from the post-condition: {other:?}"),
    }
    assert!(
        refusal.to_string().contains("the owner annotated this"),
        "a refusal that does not name what was about to be destroyed leaves its reader \
         searching: {refusal}"
    );
}

#[test]
fn c3_the_nominal_removal_gives_the_document_back_with_every_comment_it_carried() {
    // The pair that gives the test above its teeth. A gate that refused every
    // removal would pass it, and would make permanently unremovable everything
    // this product has ever posed — the one outcome worse than a refusal to
    // pose.
    let (written, trace) = posed();

    let removed = remove(&written, &trace).expect("the nominal removal must succeed");

    assert_eq!(
        removed, DOCUMENT,
        "replaying the trace must return the document from before, byte for byte"
    );
    assert!(
        removed.contains("// the owner wrote this"),
        "the comment the document already carried must come back with it"
    );
}

#[test]
fn c3_a_removal_is_not_refused_for_a_comment_its_owner_added_outside_the_passage() {
    // The other half of the same guard, and the sharper one: the document
    // **did** change between the pose and the removal, and the removal must
    // still go through. A gate that compared the document to the one the pose
    // saw would refuse here, and an entry posed on a machine whose owner edits
    // their settings would become unremovable the first time they did.
    let (written, trace) = posed();
    let edited = written.replace(
        "\t\"model\": \"opus\",",
        "\t// the owner added this line later\n\t\"model\": \"opus\",",
    );
    assert_ne!(
        edited, written,
        "the owner's edit must land on the document"
    );

    let removed =
        remove(&edited, &trace).expect("a removal outside the posed passage must succeed");

    for comment in [
        "// the owner wrote this",
        "// the owner added this line later",
    ] {
        assert!(
            removed.contains(comment),
            "the removal must give back {comment:?}: {removed}"
        );
    }
    assert!(
        !removed.contains("statusLine"),
        "the removal must still take back what the product posed: {removed}"
    );
}
