//! A2 — a registry that cannot be read is copied, never replaced.
//!
//! A test prefixed with an identifier realises that requirement. A2 is the one
//! this file exists for: **when the registry is there and its content cannot be
//! rendered, the existing file is preserved, the caller is handed a path that
//! names it, and nothing is ever written over it** — and **a whole copy of the
//! registry is distinguishable, by reading it alone, from a copy whose own write
//! was interrupted**.
//!
//! The second half is what the first is worth. A copy amputated by an
//! interrupted write, restored as though it were whole, takes the description of
//! everything its missing lines named off the machine: each of those things
//! stays where it was posed, nothing can reach it any more, and no error is
//! reported. That is the one damage this crate exists against, manufactured by
//! the very gesture meant to prevent it. So completeness is a property that can
//! be **observed on the file**, and never an assumption about how it was
//! written.
//!
//! It is a file of its own rather than a section of A1's. A1 is about what a
//! read refuses and why; this is about what survives a write that did not
//! finish, and the two families share no fixture beyond the shape of a registry
//! line.
//!
//! Each test works in its own directory: a copy of the registry and the
//! temporary of a write both land beside it, so two tests sharing a directory
//! would see each other.

use std::fs;
use std::path::PathBuf;

use rigger_apply::SystemLiveness;
use rigger_registry::{
    exit_code, transact, Address, Backup, Consent, Decision, Entry, Mutation, Outcome, Posting,
    Proposal, Registry, RegistryError, IMPOSSIBLE_REQUEST, RUNTIME_FAILURE,
};

/// An empty working directory, private to this test.
fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-backup-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create the working directory");
    path
}

/// A registry written by the test, in the format on disk rather than through the
/// product's own renderer: a fixture built by the code under test would agree
/// with it whatever either of them did.
fn registry_with(dir: &std::path::Path, document: &str) -> Registry {
    let path = dir.join("registry");
    fs::write(&path, document).expect("write the registry");
    Registry::at(path)
}

/// Where a copy of that registry lands.
fn copy_of_registry(dir: &std::path::Path) -> PathBuf {
    dir.join("registry.rigger-backup")
}

/// One entry line, as the format writes it: the seven fixed fields, then the
/// trace of the behaviour that posed.
fn entry_line(id: &str, address: &str) -> String {
    format!(
        "entry\t{id}\tacme\tlink\t1.4\t/home/someone\t{address}\t0123456789abcdef\t\
         /store/{id}\tlink\t0123456789abcdef"
    )
}

/// A registry document holding one entry.
fn one_entry() -> String {
    format!(
        "rigger-registry 1\n{}\n",
        entry_line("acme/skill", "/home/someone/settings.json")
    )
}

/// A caller that answers yes. Consent is a decision handed to the crate, and
/// this crate never reads a terminal.
struct Granting;

impl Consent for Granting {
    fn decide(&self, _: &Proposal<'_>) -> Decision {
        Decision::Granted
    }
}

/// Recording one thing as posed — a change to make so that a write happens at
/// all. What it records is of no consequence here.
fn posing(id: &str) -> Mutation {
    Mutation::Upsert(Entry::posted(Posting {
        id: id.to_string(),
        provenance: "acme".to_string(),
        behaviour: "link".to_string(),
        posed_by: "1.5".to_string(),
        root: Address::new(std::path::Path::new("/home/someone")).expect("a UTF-8 address"),
        address: Address::new(std::path::Path::new("other.json")).expect("a UTF-8 address"),
        fingerprint: "0123456789abcdef".to_string(),
        trace: vec![
            "/store/acme-other".to_string(),
            "link".to_string(),
            "0123456789abcdef".to_string(),
        ],
    }))
}

/// A whole copy, written out by hand in the format rather than through the
/// product's own writer — a fixture the code under test produced would agree
/// with it whatever either of them did.
///
/// The copy, a separator, then the witness line that says how many bytes the
/// copy is, and nothing after it.
fn whole_copy(document: &str) -> String {
    format!("{document}\nrigger-registry-backup {}\n", document.len())
}

#[test]
fn a2_a_whole_copy_beside_the_registry_is_recognised_and_its_content_is_offered() {
    // GIVEN a registry, and beside it a copy written whole down to its witness.
    // That is the state on disk a run leaves behind when it is stopped after
    // taking the copy and before writing the registry — and the state is what
    // the scenario describes. How the run died is not staged, because nothing
    // measured here depends on it: what is measured is the reading.
    let dir = directory("whole-copy");
    let document = one_entry();
    let registry = registry_with(&dir, &document);
    fs::write(copy_of_registry(&dir), whole_copy(&document)).expect("write the copy");

    // WHEN a later run reads what is beside the registry.
    let backup = Backup::beside(registry.path());

    // THEN the copy is recognised as whole, it is named, and its content is
    // handed back. Recognised and then not handed back, nothing could resume
    // from it: the file would be known good and still be of no use to anybody.
    match &backup {
        Backup::Complete(copy) => {
            assert_eq!(copy.path(), copy_of_registry(&dir));
            assert_eq!(
                copy.document(),
                document.as_bytes(),
                "the copy was recognised but its content was not the registry's"
            );
        }
        other => panic!("a copy written whole was not recognised as one: {other:?}"),
    }
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a2_a_copy_whose_write_stopped_partway_is_recognised_and_is_not_offered() {
    // GIVEN a copy whose own write was interrupted — a prefix of a whole one,
    // which is what a run killed while writing leaves on the disk.
    let dir = directory("stopped-copy");
    let document = one_entry();
    let registry = registry_with(&dir, &document);
    let whole = whole_copy(&document);
    let path = copy_of_registry(&dir);
    fs::write(&path, &whole.as_bytes()[..whole.len() / 2]).expect("write the truncated copy");

    // WHEN a later run reads it.
    let backup = Backup::beside(registry.path());

    // THEN it is recognised as truncated, and it hands back no content at all:
    // there is no way to offer part of it, because nothing here can tell how
    // much of it is missing.
    assert!(
        matches!(&backup, Backup::Truncated { path: named } if named == &path),
        "a copy whose write stopped partway was taken for a whole one: {backup:?}"
    );

    // AND the message names the file and says that it is truncated. It is pinned
    // whole rather than searched for those two facts, because a message may name
    // them and go on to say something that undoes them; only an assertion on the
    // whole of it goes red then.
    assert_eq!(
        backup.to_string(),
        format!(
            "{}: a copy of the registry whose own write was interrupted — it does not carry the \
             witness written last, so it is truncated, nothing here can tell how much of it is \
             missing, and it is not offered as a state to resume from",
            path.display()
        )
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: a file whose last line is shaped like the witness. No
/// scenario of A2 names it, and the answer decides how much the witness is
/// worth.
///
/// The file being copied is, by construction, one this build could not read, so
/// nothing may be assumed about what is in it — including that none of its lines
/// reads like a witness. Two things stop such a line from passing for one, and
/// both are measured here: its number has to agree with the offset the line opens
/// at, and the line has to be terminated, because the one this module writes is
/// the last thing in the file and ends it.
///
/// **It does not measure that no forged line passes**, because one does: a line
/// whose number agrees with where it opens is indistinguishable from a witness
/// this module wrote, whoever wrote it. That case is accounted for where the
/// format is described, and it is not asserted away here.
#[test]
fn guard_a_witness_is_terminated_and_accounts_for_where_it_opens() {
    let dir = directory("witness-shaped");
    let registry = registry_with(&dir, &one_entry());
    let path = copy_of_registry(&dir);

    // A copy whose own content ends on a line shaped like the witness, and whose
    // declared length accounts for nothing.
    fs::write(&path, "rigger-registry 1\nrigger-registry-backup 4\n").expect("write the copy");
    assert!(
        matches!(Backup::beside(registry.path()), Backup::Truncated { .. }),
        "a line shaped like the witness was taken for one"
    );

    // A copy cut inside its own witness line. What refuses it is the offset
    // check above and not the line break below: the digits left behind still
    // parse, and the number they make no longer accounts for where the line
    // opens.
    let whole = whole_copy(&one_entry());
    fs::write(&path, &whole.as_bytes()[..whole.len() - 3]).expect("write the copy");
    assert!(
        matches!(Backup::beside(registry.path()), Backup::Truncated { .. }),
        "a copy cut inside its witness was taken for a whole one"
    );

    // A copy cut on the last byte of its witness line — the one truncation the
    // offset check cannot see, because everything before the missing line break
    // agrees with itself. The line break is what refuses it, and nothing else
    // does.
    fs::write(&path, &whole.as_bytes()[..whole.len() - 1]).expect("write the copy");
    assert!(
        matches!(Backup::beside(registry.path()), Backup::Truncated { .. }),
        "a copy whose witness line never ended was taken for a whole one"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a2_an_unreadable_registry_is_left_on_the_disk_and_the_refusal_advises_no_remedy() {
    // GIVEN a registry that is there and whose content this build cannot render
    // — here, one declaring a format version it does not read.
    let dir = directory("unreadable-left-alone");
    let document = format!(
        "rigger-registry 7\n{}\n",
        entry_line("acme/skill", "/home/someone/settings.json")
    );
    let registry = registry_with(&dir, &document);
    let before = fs::read(registry.path()).expect("read the registry back");

    // WHEN the product is asked to record something in it — the one path that
    // would replace it — and hands back.
    let failure = transact(
        &registry,
        &[posing("acme/other")],
        &Granting,
        &SystemLiveness,
    )
    .expect_err("a registry this build cannot read was written over");

    // THEN the registry is still on the disk, identical byte for byte. Replaced
    // by an empty one, it would stop describing everything that has been posed
    // on this machine, and every one of those things would become permanently
    // unremovable in the same gesture.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    assert_eq!(
        files(&dir),
        vec!["registry".to_string()],
        "the refusal left something beside the registry"
    );

    // AND the whole message is this, and nothing else. It is pinned entire
    // rather than searched for advice to delete or to move the file aside,
    // because a list of forbidden words does not close the set of ways to give
    // that advice: only an assertion on the whole of it goes red when a tail is
    // added. And the advice is not withheld out of terseness — a product that
    // tells its owner to delete the registry tells them to delete the
    // description of everything they posed.
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: the registry declares format version 7, and this build reads version 1 — it is \
             left exactly as it is, because it is the only description of what has been posed on \
             this machine; no copy of the registry is beside it",
            registry.path().display()
        )
    );

    // AND the exit code tells this refusal apart from a usage error: a script
    // that cannot distinguish "your registry does not read" from "you mistyped a
    // flag" retries the second forever.
    assert_eq!(exit_code(&failure), RUNTIME_FAILURE);
    assert_ne!(exit_code(&failure), IMPOSSIBLE_REQUEST);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a2_the_refusal_of_an_unreadable_registry_names_it_and_the_copy_beside_it() {
    // GIVEN a registry this build cannot read, and beside it the whole copy a
    // run interrupted before its write left behind.
    let dir = directory("unreadable-named");
    let registry = registry_with(&dir, "rigger-registry 7\n");
    let copied = one_entry();
    fs::write(copy_of_registry(&dir), whole_copy(&copied)).expect("write the copy");

    // WHEN the product hands back.
    let failure = transact(
        &registry,
        &[posing("acme/other")],
        &Granting,
        &SystemLiveness,
    )
    .expect_err("a registry this build cannot read was written over");

    // THEN the refusal carries, in typed fields, the registry that was preserved
    // and the copy beside it with what that copy is worth. Named in its text and
    // nowhere else, the two files would have to be parsed back out of a sentence
    // — and a caller that cannot name them cannot offer either of them.
    match &failure {
        RegistryError::Unreadable {
            registry: named,
            backup,
            ..
        } => {
            assert_eq!(named, registry.path());
            match backup {
                Backup::Complete(copy) => {
                    assert_eq!(copy.path(), copy_of_registry(&dir));
                    assert_eq!(copy.document(), copied.as_bytes());
                }
                other => panic!("the refusal does not carry the copy beside it: {other:?}"),
            }
        }
        other => panic!("the refusal does not name what was preserved: {other}"),
    }

    // AND the whole rendering is this, and nothing else. The typed fields above
    // say nothing about what is written out, and this is the rendering of the
    // interesting case — a registry that does not read, with a whole copy of it
    // right there. It is the one where advice to delete the registry and rename
    // the copy over it is most tempting, and where taking that advice while the
    // copy describes a superseded registry costs a record.
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: the registry declares format version 7, and this build reads version 1 — it is \
             left exactly as it is, because it is the only description of what has been posed on \
             this machine; {}: a whole copy of the registry, {} bytes — the registry as it stood \
             when the copy was taken",
            registry.path().display(),
            copy_of_registry(&dir).display(),
            copied.len()
        )
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: the renderings of a refusal that no scenario reaches.
///
/// A2 requires that no message suggest deleting the registry or moving it aside,
/// and the tests that realise it pin one rendering each — the refusal with no
/// copy beside it, and the refusal with a whole one. A refusal is rendered from
/// the copy it carries, so there are two more, and a tail added to either of them
/// advises a remedy in exactly the same way while every test stays green.
///
/// **The same hole is not particular to this refusal, so this guard is not
/// either.** A refusal whose rendering varies with what it carries has as many
/// renderings as it has shapes, and a scenario reaches the shape it needs and no
/// other. The last one added is below: the record that names a behaviour this
/// build no longer carries hands back the fields the record holds, and a
/// scenario always has some — so the rendering of one that has none is reached
/// by nothing else. Nothing here realises a scenario; all of it protects one.
#[test]
fn guard_no_rendering_of_a_refusal_advises_a_remedy() {
    // A copy whose own write stopped partway, beside a registry that does not
    // read.
    let dir = directory("no-remedy-truncated");
    let registry = registry_with(&dir, "rigger-registry 7\n");
    let whole = whole_copy(&one_entry());
    fs::write(copy_of_registry(&dir), &whole.as_bytes()[..whole.len() / 2])
        .expect("write the truncated copy");
    let failure = transact(
        &registry,
        &[posing("acme/other")],
        &Granting,
        &SystemLiveness,
    )
    .expect_err("a registry this build cannot read was written over");
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: the registry declares format version 7, and this build reads version 1 — it is \
             left exactly as it is, because it is the only description of what has been posed on \
             this machine; {}: a copy of the registry whose own write was interrupted — it does \
             not carry the witness written last, so it is truncated, nothing here can tell how \
             much of it is missing, and it is not offered as a state to resume from",
            registry.path().display(),
            copy_of_registry(&dir).display()
        )
    );
    fs::remove_dir_all(&dir).expect("clean up");

    // A copy the system will not read at all — here, a directory standing where
    // the copy would be. What the system reports is its own; the shape around it
    // is what is pinned.
    let dir = directory("no-remedy-unreadable");
    let registry = registry_with(&dir, "rigger-registry 7\n");
    fs::create_dir_all(copy_of_registry(&dir)).expect("occupy the place of the copy");
    let detail = fs::read(copy_of_registry(&dir)).expect_err("the copy must not be readable");
    let failure = transact(
        &registry,
        &[posing("acme/other")],
        &Granting,
        &SystemLiveness,
    )
    .expect_err("a registry this build cannot read was written over");
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: the registry declares format version 7, and this build reads version 1 — it is \
             left exactly as it is, because it is the only description of what has been posed on \
             this machine; {}: a copy of the registry that cannot be read — {detail} — so it is \
             not offered as a state to resume from",
            registry.path().display(),
            copy_of_registry(&dir).display()
        )
    );
    fs::remove_dir_all(&dir).expect("clean up");

    // A record naming a behaviour this build no longer carries, holding no
    // recorded fields at all. The scenario that realises this refusal pins the
    // rendering with fields; this is the other one, and it is the shape in which
    // "here is what to undo by hand" is at its emptiest — which is where advice
    // to delete the record and be done with it would be most tempting to add.
    let failure = RegistryError::BehaviourGone {
        behaviour: "merge/toml".to_string(),
        posed_by: "1.4".to_string(),
        address: PathBuf::from("/home/someone/settings.toml"),
        trace: Vec::new(),
    };
    assert_eq!(
        failure.to_string(),
        "/home/someone/settings.toml: posed through behaviour `merge/toml` by version 1.4 of the \
         product, and this build carries no behaviour of that name — nothing was undone, the \
         record is left exactly as it is, and no neighbouring behaviour was tried in its place; \
         what the record holds, to be undone by hand, is []"
    );
}

/// Lays out a registry whose content cannot be rendered, puts a whole copy of a
/// registry beside it, and answers with what the product hands back when it is
/// asked to write.
fn refusal_over(name: &str, lay: impl FnOnce(&std::path::Path)) -> RegistryError {
    let dir = directory(name);
    let path = dir.join("registry");
    lay(&path);
    fs::write(copy_of_registry(&dir), whole_copy(&one_entry())).expect("write the copy");
    let failure = transact(
        &Registry::at(&path),
        &[posing("acme/other")],
        &Granting,
        &SystemLiveness,
    )
    .expect_err("a registry whose content cannot be rendered was written over");
    fs::remove_dir_all(&dir).expect("clean up");
    failure
}

/// One road to a registry whose content will not render: what it is, what the
/// product handed back on it, and which refusal it should have come from.
type Road = (&'static str, RegistryError, fn(&RegistryError) -> bool);

/// Guard, not scenario: every way the registry's content fails to render.
///
/// The scenarios of A2 need one such registry and reach for the nearest — an
/// envelope of an unknown version. There are four, they arrive at the same place
/// by four different roads, and a road that stops short of it hands back a bare
/// refusal: the registry named, and no copy reachable from it. The copy is half
/// of what A2 asks for, and the half that gets lost is the one that would have
/// been offered as a state to resume from.
///
/// The road most worth walking is the registry that is not UTF-8. It is the one
/// this crate refuses rather than reading "with replacement bytes that would
/// destroy what they replace" — so it is the one where the file is most
/// obviously worth copying, and it is reached by no scenario at all.
#[test]
fn guard_every_way_the_registry_fails_to_render_preserves_it_and_names_the_copy() {
    let roads: [Road; 4] = [
        (
            "an envelope of a version this build does not read",
            refusal_over("road-envelope-unknown", |path| {
                fs::write(path, "rigger-registry 7\n").expect("write the registry");
            }),
            |cause| matches!(cause, RegistryError::EnvelopeUnknown { .. }),
        ),
        (
            "no envelope at all",
            refusal_over("road-envelope-missing", |path| {
                fs::write(
                    path,
                    format!("{}\n", entry_line("acme/skill", "settings.json")),
                )
                .expect("write the registry");
            }),
            |cause| matches!(cause, RegistryError::EnvelopeMissing { .. }),
        ),
        (
            "bytes no UTF-8 decoder accepts",
            refusal_over("road-not-utf8", |path| {
                fs::write(path, [0xffu8, 0xfe]).expect("write the registry");
            }),
            |cause| matches!(cause, RegistryError::NotUtf8 { .. }),
        ),
        (
            "a registry the system will not read at all",
            refusal_over("road-read", |path| {
                fs::create_dir_all(path).expect("put something unreadable at the registry's path");
            }),
            |cause| matches!(cause, RegistryError::Read { .. }),
        ),
    ];

    for (road, failure, is_the_cause) in &roads {
        match failure {
            RegistryError::Unreadable { cause, backup, .. } => {
                assert!(
                    is_the_cause(cause),
                    "the refusal over {road} does not carry the cause it came from: {failure}"
                );
                assert!(
                    matches!(backup, Backup::Complete(_)),
                    "the refusal over {road} does not reach the copy beside the registry: \
                     {failure}"
                );
            }
            other => panic!("the refusal over {road} preserves nothing and names nothing: {other}"),
        }
    }
}

/// Guard, not scenario: the copy the product writes, read back by the product.
///
/// Every test above builds its copy by hand, on purpose: the reader is measured
/// against the format, and not against whatever the writer happens to produce —
/// which would leave the two free to agree on nothing at all. That leaves one
/// thing unmeasured, and it is this: whether the writer produces what the reader
/// calls whole. It is the seam between them, and the only test that needs both.
#[test]
fn guard_the_copy_a_write_takes_reads_back_whole_and_holds_the_registry() {
    let dir = directory("copy-round-trip");
    let document = one_entry();
    let registry = registry_with(&dir, &document);

    let held = registry
        .lock()
        .acquire(&SystemLiveness)
        .expect("take the exclusion the copy is made under");
    let taken = Backup::take(registry.path(), &held).expect("take the copy");
    assert_eq!(taken.path(), Some(copy_of_registry(&dir).as_path()));
    drop(held);

    match Backup::beside(registry.path()) {
        Backup::Complete(copy) => {
            assert_eq!(copy.path(), copy_of_registry(&dir));
            assert_eq!(
                copy.document(),
                document.as_bytes(),
                "the copy the write takes does not hold the registry it copied"
            );
        }
        other => panic!("the copy the write takes does not read back whole: {other:?}"),
    }
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: what a write does when the copy cannot be taken at all.
/// No scenario of A2 names it, and the answer decides whether the copy is a
/// precondition of the write or a courtesy beside it.
///
/// A courtesy is worth nothing: the run that most needs the copy is the one
/// whose machine is refusing writes, and that is exactly the run a courtesy
/// skips. So the write does not happen, and the registry stays the only
/// description of what has been posed.
#[test]
fn guard_the_registry_is_not_replaced_when_the_copy_cannot_be_taken() {
    // GIVEN a registry, and something in the place its copy would be written
    // that cannot be written over.
    let dir = directory("copy-refused");
    let registry = registry_with(&dir, &one_entry());
    let before = fs::read(registry.path()).expect("read the registry back");
    fs::create_dir_all(copy_of_registry(&dir)).expect("occupy the place of the copy");

    // WHEN the product is asked to record something.
    let failure = transact(
        &registry,
        &[posing("acme/other")],
        &Granting,
        &SystemLiveness,
    )
    .expect_err("the registry was replaced although no copy of it could be taken");

    // THEN it fails naming the copy that could not be written.
    assert!(
        matches!(&failure, RegistryError::Write { path, .. } if path == &copy_of_registry(&dir)),
        "the refusal does not name the copy that could not be taken: {failure}"
    );

    // AND the registry is identical, byte for byte, to what it was.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: what becomes of the copy once the write it covered has
/// happened. No scenario of A2 names it, and the answer decides what a later run
/// is offered.
///
/// Left behind, the copy describes a registry that has been superseded, and it
/// carries its witness — so the next run reads it as a whole state to resume
/// from and is offered the registry as it stood before the write it is looking
/// at. The copy exists for the interval between the two writes, and it is taken
/// away when that interval closes.
#[test]
fn guard_a_copy_does_not_outlive_the_write_it_covered() {
    let dir = directory("copy-transient");
    let registry = registry_with(&dir, &one_entry());

    let outcome = transact(
        &registry,
        &[posing("acme/other")],
        &Granting,
        &SystemLiveness,
    )
    .expect("the transaction must succeed");
    assert!(matches!(outcome, Outcome::Committed { .. }));

    assert!(
        matches!(Backup::beside(registry.path()), Backup::Absent),
        "a write that finished left its copy behind, and the next run would resume from it"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: a proof of holding made for another registry. No
/// scenario of A2 names it, and the answer decides whether the proof the copy
/// asks for is about anything in particular.
///
/// A proof of holding is a proof about **one** exclusion. Taken as proof of any,
/// a run holding registry A's could copy over registry B while the run that
/// really holds B is between its own copy and its write — the exclusion doing
/// nothing at all while appearing to work, which is the same defect the write
/// itself is guarded against.
#[test]
fn guard_a_copy_refuses_a_proof_of_holding_another_registrys_exclusion() {
    let dir = directory("copy-foreign-proof");
    let registry = registry_with(&dir, &one_entry());
    let elsewhere = Registry::at(dir.join("other-registry"));
    let held = elsewhere
        .lock()
        .acquire(&SystemLiveness)
        .expect("take another registry's exclusion");

    let failure = Backup::take(registry.path(), &held)
        .expect_err("a copy was taken under another registry's exclusion");

    assert!(
        matches!(
            &failure,
            RegistryError::LockElsewhere { registry: named, expected, held: shown }
                if named == registry.path()
                    && expected == registry.lock().path()
                    && shown == elsewhere.lock().path()
        ),
        "the refusal does not name the exclusion held and the one that guards this registry: \
         {failure}"
    );
    assert!(
        matches!(Backup::beside(registry.path()), Backup::Absent),
        "a copy was written under another registry's exclusion"
    );
    drop(held);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: the permissions the copy carries. No scenario of A2
/// names them, and the answer decides whether protecting a registry is what
/// exposes it.
///
/// Created from nothing, a file gets what the process umask leaves of `0666` —
/// commonly `0644`. A registry its owner had restricted to `0600` because it
/// describes their machine would then be copied into a file every account on
/// that machine can read, silently, by the gesture meant to protect it.
#[cfg(unix)]
#[test]
fn guard_a_copy_carries_the_permissions_of_the_registry() {
    use std::os::unix::fs::PermissionsExt;

    let dir = directory("copy-permissions");
    let registry = registry_with(&dir, &one_entry());
    fs::set_permissions(registry.path(), fs::Permissions::from_mode(0o600))
        .expect("restrict the registry");

    let held = registry
        .lock()
        .acquire(&SystemLiveness)
        .expect("take the exclusion the copy is made under");
    Backup::take(registry.path(), &held).expect("take the copy");
    drop(held);

    let mode = fs::metadata(copy_of_registry(&dir))
        .expect("read the copy's metadata")
        .permissions()
        .mode()
        & 0o7777;
    assert_eq!(
        mode, 0o600,
        "the copy of a restricted registry is readable by accounts the registry is not"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// The files present in a directory, sorted — enough to observe that nothing was
/// left beside the registry.
fn files(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read the directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}
