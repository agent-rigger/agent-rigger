//! A1 — the envelope of the registry fails closed, and an entry does not.
//!
//! A test prefixed with an identifier realises that requirement. A1 is the one
//! this file exists for: **a registry whose top-level envelope is not the
//! expected one is refused by naming what was found and what was expected,
//! before anything is written, and it is never coerced into an empty registry**
//! — coercing it destroys the only description of what has been posed and makes
//! all of it unremovable in the same gesture. The tolerance is granted at the
//! level of **one entry**, never of the envelope.
//!
//! Each test works in its own directory: a registry's write puts a temporary
//! beside it, so two tests sharing a directory would see each other.

use std::fs;
use std::path::PathBuf;

use rigger_registry::{exit_code, Registry, RegistryError, IMPOSSIBLE_REQUEST, RUNTIME_FAILURE};

/// An empty working directory, private to this test.
fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-registry-{name}-{}", std::process::id()));
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

/// One entry line, as the format writes it: the named fields, then the trace of
/// the behaviour that posed — here a link, whose trace is a store entry, a
/// placement and the fingerprint of what was materialised, carried in one field
/// and separated by the escape the format writes.
fn entry_line(id: &str, behaviour: &str, posed_by: &str, address: &str) -> String {
    format!(
        "entry\tid={id}\tprovenance=acme\tbehaviour={behaviour}\tposed_by={posed_by}\t\
         root=/home/someone\taddress={address}\tfingerprint=0123456789abcdef\t\
         trace=/store/{id}\\tlink\\t0123456789abcdef"
    )
}

#[test]
fn a1_a_registry_written_by_a_version_this_build_does_not_read_is_refused_and_left_alone() {
    // GIVEN a registry whose envelope declares a format version this build does
    // not know.
    let dir = directory("newer-envelope");
    let document = format!(
        "rigger-registry 3\n{}\n",
        entry_line("acme/skill", "merge", "1.4", "/home/someone/settings.json")
    );
    let registry = registry_with(&dir, &document);
    let before = fs::read(registry.path()).expect("read the registry back");

    // WHEN a command that reads the registry runs.
    let failure = registry
        .read()
        .expect_err("a registry of an unknown format was read as if this build understood it");

    // THEN it fails while naming the version found and the version expected —
    // and not merely the one expected, which would leave its owner unable to
    // tell which product wrote this.
    match &failure {
        RegistryError::EnvelopeUnknown {
            path,
            found,
            expected,
        } => {
            assert_eq!(path, registry.path());
            assert_eq!(found, "3");
            assert_eq!(*expected, 2);
        }
        other => panic!("the refusal does not name the envelope: {other}"),
    }
    let message = failure.to_string();
    assert!(message.contains('3'), "{message}");
    assert!(message.contains('2'), "{message}");

    // AND the registry file is identical, byte for byte, to what it was — never
    // coerced into an empty registry, which would destroy the only description
    // of everything posed on this machine.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    assert_eq!(
        files(&dir),
        vec!["registry".to_string()],
        "the refusal left something beside the registry"
    );

    // AND the exit code tells this refusal apart from a usage error: a script
    // that cannot distinguish "your registry is from a newer product" from "you
    // mistyped a flag" retries the second forever.
    assert_eq!(exit_code(&failure), RUNTIME_FAILURE);
    assert_ne!(exit_code(&failure), IMPOSSIBLE_REQUEST);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a1_a_registry_without_an_envelope_names_the_absence_and_assumes_no_version() {
    // GIVEN a registry whose root document carries no version field at all.
    let dir = directory("no-envelope");
    let document = format!(
        "{}\n",
        entry_line("acme/skill", "merge", "1.4", "/home/someone/settings.json")
    );
    let registry = registry_with(&dir, &document);
    let before = fs::read(registry.path()).expect("read the registry back");

    // WHEN a read runs.
    let failure = registry
        .read()
        .expect_err("a registry with no envelope was read under an assumed version");

    // THEN it names the absence, and not an unexpected value: the two are
    // different events, and a single variant for both makes the message unable
    // to say which happened.
    assert!(
        matches!(&failure, RegistryError::EnvelopeMissing { path } if path == registry.path()),
        "the refusal does not name the absence of an envelope: {failure}"
    );

    // AND no default version is assumed: nothing was read, and nothing was
    // written.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// The same requirement on a document that opens with the marker and stops
/// there. It is the case a build could be tempted to complete from a default,
/// and completing it is what A1 forbids.
#[test]
fn a1_an_envelope_with_no_version_is_an_absence_and_not_an_unknown_value() {
    let dir = directory("truncated-envelope");
    let registry = registry_with(&dir, "rigger-registry\n");

    let failure = registry
        .read()
        .expect_err("an envelope carrying no version was completed from a default");

    assert!(
        matches!(&failure, RegistryError::EnvelopeMissing { .. }),
        "an envelope with no version was reported as an unexpected value: {failure}"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a1_one_unreadable_entry_out_of_twelve_is_unjudgeable_and_the_other_eleven_are_returned() {
    // GIVEN a registry whose envelope is valid and one of whose twelve entries
    // is unreadable.
    let dir = directory("one-corrupt-entry");
    let mut document = String::from("rigger-registry 2\n");
    for index in 0..11 {
        document.push_str(&entry_line(
            &format!("acme/skill-{index}"),
            "merge",
            "1.4",
            &format!("/home/someone/settings-{index}.json"),
        ));
        document.push('\n');
    }
    // A line that is well formed but for the one field it does not carry. Under
    // a positional format the same fixture was a short line, and the reason it
    // produced came from the fourth position being read as the posing version;
    // with named fields, a missing name is what a missing field is.
    document.push_str(
        "entry\tid=acme/skill-11\tprovenance=acme\tbehaviour=link\troot=/home/someone\t\
         address=settings-11.json\tfingerprint=0123456789abcdef\n",
    );
    let registry = registry_with(&dir, &document);

    // WHEN a read runs.
    let ledger = registry
        .read()
        .expect("one unreadable entry made the whole registry unreadable");

    // THEN the eleven readable entries are returned.
    assert_eq!(ledger.entries().len(), 11);
    assert_eq!(ledger.entries()[0].id(), "acme/skill-0");
    assert_eq!(ledger.entries()[10].id(), "acme/skill-10");

    // AND the twelfth is reported unjudgeable, with its reason — a report that
    // says only "unjudgeable" leaves its reader nothing to act on.
    assert_eq!(ledger.unjudgeable().len(), 1);
    let unreadable = &ledger.unjudgeable()[0];
    assert_eq!(unreadable.line(), 13);
    assert_eq!(
        unreadable.reason(),
        "the line carries no posing version",
        "the unjudgeable entry does not carry the reason it is one"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: no scenario of A1 says what becomes of an unreadable
/// entry when the registry is written again, and the answer decides whether the
/// tolerance is a tolerance at all.
///
/// Dropped on the next write, the unreadable line is gone for good — which is
/// the envelope's own damage at the size of one entry: the description of
/// something posed disappears, and what it describes becomes permanently
/// unremovable. So it comes back out, byte for byte.
#[test]
fn guard_an_unreadable_entry_is_written_back_unchanged() {
    use rigger_apply::SystemLiveness;
    use rigger_plan::{Digest, Placement, Trace};
    use rigger_registry::{
        transact, Address, Consent, Decision, Entry, Mutation, Outcome, Posting, Proposal,
    };

    struct Granting;
    impl Consent for Granting {
        fn decide(&self, _: &Proposal<'_>) -> Decision {
            Decision::Granted
        }
    }

    let dir = directory("keep-unreadable");
    const UNREADABLE: &str = "entry\tacme/older\tacme\tlink";
    let document = format!(
        "rigger-registry 2\n{}\n{UNREADABLE}\n",
        entry_line("acme/skill", "merge", "1.4", "/home/someone/settings.json")
    );
    let registry = registry_with(&dir, &document);

    let outcome = transact(
        &registry,
        &[Mutation::Upsert(
            Entry::posted(Posting {
                id: "acme/other".to_string(),
                provenance: "acme".to_string(),
                behaviour: "link".to_string(),
                posed_by: "1.5".to_string(),
                root: Address::new(std::path::Path::new("/home/someone")).expect("a UTF-8 address"),
                address: Address::new(std::path::Path::new("other.json")).expect("a UTF-8 address"),
                fingerprint: "0123456789abcdef".to_string(),
                trace: Trace::Link {
                    store: std::path::PathBuf::from("/store/acme-other"),
                    placement: Placement::Link,
                    posed: Digest::read("0123456789abcdef")
                        .expect("a fingerprint this build wrote"),
                },
            })
            .expect("a link trace records"),
        )],
        &Granting,
        &SystemLiveness,
    )
    .expect("the transaction must succeed");
    assert!(matches!(outcome, Outcome::Committed { .. }));

    let written = fs::read_to_string(registry.path()).expect("read the registry back");
    assert!(
        written.contains(UNREADABLE),
        "the write dropped the entry it could not read: {written}"
    );
    let reread = registry.read().expect("read the registry back");
    assert_eq!(reread.entries().len(), 2);
    assert_eq!(reread.unjudgeable().len(), 1);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: two readable lines carrying one identifier. A1 grants
/// its tolerance at the level of one entry, and says nothing about a registry
/// this build did not write; the answer decides whether a **readable** line is
/// treated worse than an illegible one.
///
/// Folded together at the read — which is what `upsert` does, and it is right
/// for a mutation — the first is dropped, and the next write takes its line out
/// of the file. That is the envelope's damage at the size of one entry, applied
/// to a line nothing was wrong with: whatever was posed at the address it named
/// becomes permanently unremovable, with no error and nothing counted. Nothing
/// here can tell which of the two describes what was posed, so neither is
/// chosen: the second is unjudgeable, and it comes back out unchanged.
#[test]
fn guard_a_second_line_under_one_identifier_is_unjudgeable_and_is_written_back() {
    use rigger_apply::SystemLiveness;
    use rigger_registry::{transact, Consent, Decision, Identity, Mutation, Outcome, Proposal};

    struct Granting;
    impl Consent for Granting {
        fn decide(&self, _: &Proposal<'_>) -> Decision {
            Decision::Granted
        }
    }

    let dir = directory("repeated-identifier");
    let first = entry_line("acme/skill", "merge", "1.4", "/home/someone/first.json");
    let second = entry_line("acme/skill", "merge", "1.4", "/home/someone/second.json");
    let registry = registry_with(&dir, &format!("rigger-registry 2\n{first}\n{second}\n"));

    // WHEN the registry is read.
    let ledger = registry.read().expect("the read must succeed");

    // THEN one line is an entry and the other is unjudgeable, with a reason
    // naming the identifier and the line that already carried it.
    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(
        ledger.entries()[0].at(),
        std::path::PathBuf::from("/home/someone/first.json")
    );
    assert_eq!(
        ledger.unjudgeable().len(),
        1,
        "a readable line disappeared at the read, and nothing counted it"
    );
    let repeated = &ledger.unjudgeable()[0];
    assert_eq!(repeated.line(), 3);
    assert!(
        repeated.reason().contains("acme/skill") && repeated.reason().contains('2'),
        "the reason does not name the identifier and the line that already carried it: {}",
        repeated.reason()
    );

    // AND a write that has nothing to do with it puts the line back, byte for
    // byte. Dropped there instead, whatever was posed at the address it names
    // could never be found again to be removed.
    let outcome = transact(
        &registry,
        &[Mutation::Remove {
            identity: Identity {
                provenance: "acme".to_string(),
                id: "acme/absent".to_string(),
            },
        }],
        &Granting,
        &SystemLiveness,
    )
    .expect("the transaction must succeed");
    assert!(matches!(outcome, Outcome::Committed { .. }));
    let written = fs::read_to_string(registry.path()).expect("read the registry back");
    assert_eq!(written, format!("rigger-registry 2\n{first}\n{second}\n"));
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: two catalogues carrying an entry of the same name. No
/// scenario of A1 names it, and the answer decides whether one record can wipe
/// another out.
///
/// `Posting::provenance` says two catalogues may legitimately carry an entry of
/// the same name — `context/agents` is a name two independent authors will both
/// choose — and that without it the two records are one. Keyed on the name
/// alone, recording the second takes the first's line out of the file: its files
/// stay on the machine, nothing describes them any more, and no error is
/// reported. It is the loss the whole crate is shaped against, produced by the
/// product's own write path.
#[test]
fn guard_two_catalogues_carrying_one_name_keep_two_records() {
    use rigger_plan::{Digest, Placement, Trace};
    use rigger_registry::{Address, Entry, Identity, Ledger, Posting};

    fn posted(provenance: &str) -> Entry {
        Entry::posted(Posting {
            id: "context/agents".to_string(),
            provenance: provenance.to_string(),
            behaviour: "link".to_string(),
            posed_by: "1.5".to_string(),
            root: Address::new(std::path::Path::new("/home/someone")).expect("a UTF-8 address"),
            address: Address::new(std::path::Path::new(&format!("{provenance}.md")))
                .expect("a UTF-8 address"),
            fingerprint: "0123456789abcdef".to_string(),
            trace: Trace::Link {
                store: std::path::PathBuf::from(format!("/store/{provenance}-agents")),
                placement: Placement::Link,
                posed: Digest::read("0123456789abcdef").expect("a fingerprint this build wrote"),
            },
        })
        .expect("a link trace records")
    }

    let mut ledger = Ledger::empty();
    ledger.upsert(posted("acme"));
    ledger.upsert(posted("globex"));

    assert_eq!(
        ledger.entries().len(),
        2,
        "recording the second took the first out, and what it described stays on the machine with \
         nothing able to reach it"
    );
    assert_eq!(
        ledger.entries()[0].address(),
        std::path::Path::new("acme.md")
    );

    // AND taking one out leaves the other. The same defect the other way round:
    // removing by name alone takes the record of a catalogue nobody asked about.
    ledger.remove(&Identity {
        provenance: "acme".to_string(),
        id: "context/agents".to_string(),
    });
    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(ledger.entries()[0].provenance(), "globex");

    // AND a registry carrying both lines reads back as two entries. Reported
    // unjudgeable instead, one of the two would be a description nothing could
    // act on — the state a repeated identity is kept in, applied to a registry
    // this build writes itself.
    let dir = directory("two-catalogues");
    let registry = registry_with(
        &dir,
        "rigger-registry 2\n\
         entry\tid=context/agents\tprovenance=acme\tbehaviour=link\tposed_by=1.5\t\
         root=/home/someone\taddress=acme.md\tfingerprint=abc\ttrace=/store/a\\tlink\\tdef\n\
         entry\tid=context/agents\tprovenance=globex\tbehaviour=link\tposed_by=1.5\t\
         root=/home/someone\taddress=globex.md\tfingerprint=abc\ttrace=/store/g\\tlink\\tdef\n",
    );
    let read = registry.read().expect("the read must succeed");
    assert_eq!(read.entries().len(), 2);
    assert!(read.unjudgeable().is_empty());
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: an address the registry cannot spell. No scenario of A1
/// names it, and the answer decides whether the trace describes the machine or
/// something adjacent to it.
///
/// A path is an arbitrary byte string and the registry is a UTF-8 document. Sent
/// through a lossy conversion, an address holding bytes no decoder accepts is
/// recorded with replacement characters in their place: the registry then names
/// an address that does not exist, and the removal that replays the trace finds
/// nothing there. The refusal on the way out already says as much — a registry
/// that is not UTF-8 is left alone "rather than read with replacement bytes that
/// would destroy what they replace" — and this is the same refusal on the way
/// in, at the moment the caller still holds the real path.
///
/// It happens at construction rather than at the write, which is what makes it
/// unskippable: `Posting` takes an `Address` and nothing else, so recording
/// the path itself is not something anybody can write down. The doctests of
/// `Address` carry that half.
#[cfg(unix)]
#[test]
fn guard_an_address_this_document_cannot_spell_is_refused_where_it_is_offered() {
    use rigger_registry::Address;
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    // GIVEN a path holding a byte no UTF-8 decoder accepts — an ordinary home
    // directory on a system this product is released for.
    let offered = PathBuf::from(OsString::from_vec(
        b"/home/someone/caf\xE9/settings.json".to_vec(),
    ));

    // WHEN it is offered as an address.
    let failure =
        Address::new(&offered).expect_err("an address the registry cannot spell was accepted");

    // THEN it is refused, naming the path that was offered, and nothing is
    // recorded under another spelling.
    assert_eq!(failure.path(), offered.as_path());
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: this path is not UTF-8, and the registry is a UTF-8 document — it is not recorded \
             under another spelling, because a record naming an address that does not exist can \
             never be undone",
            offered.display()
        )
    );

    // AND an address the document can spell goes through untouched: without
    // this, a constructor that refused everything would pass the assertion
    // above and record nothing at all.
    let ordinary =
        Address::new(std::path::Path::new("/home/someone/settings.json")).expect("a UTF-8 address");
    assert_eq!(
        ordinary.as_path(),
        std::path::Path::new("/home/someone/settings.json")
    );
}

#[test]
fn a1_the_refusal_names_the_fact_and_the_expected_version_and_advises_no_remedy() {
    // GIVEN a registry of an unknown envelope.
    let dir = directory("no-remedy");
    let registry = registry_with(&dir, "rigger-registry 7\n");

    // WHEN the command refuses.
    let failure = registry.read().expect_err("the read must refuse");

    // THEN the whole message is this, and nothing else. It is pinned entire
    // rather than searched for forbidden words, because a list of forbidden
    // words does not close the set of ways to advise a remedy: "delete the file
    // and start again" and "move it aside" would both pass such a list. What
    // makes the property hold is that the message is built from the typed fields
    // of the refusal and has no free-text tail — and only an assertion on the
    // whole of it goes red when a tail is added.
    assert_eq!(
        failure.to_string(),
        format!(
            "{}: the registry declares format version 7, and this build reads version 2 — it is \
             left exactly as it is, because it is the only description of what has been posed on \
             this machine",
            registry.path().display()
        )
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
