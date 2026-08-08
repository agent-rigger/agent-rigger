//! The shape of the registry document, and what a build does with a field it
//! does not know.
//!
//! **Almost nothing here realises a scenario, and that is what it is.** The
//! format is not a requirement; it is what the requirements rest on. A1 says an
//! entry this build cannot read costs one entry and is written back byte for
//! byte, A2 says a registry that does not render is preserved, A5 says a
//! behaviour the closed set has lost is refused by naming it — every one of them
//! assumes a line can be read, and a positional line makes every field ever
//! added reinterpret the fields already written.
//!
//! So the entry is a set of **named fields**, and this file holds the properties
//! that makes true: reading does not depend on the order, a name this build does
//! not know travels through untouched, and the three malformations that cannot
//! be tidied up are refused one entry at a time with the bytes kept.
//!
//! **Two regimes, and one of them is the reason the other is safe.** A name this
//! build does not know and that decides no write is carried and ignored. A name
//! that **decides a write** is marked, and a marked name this build does not
//! carry makes the entry unjudgeable. Without the second, a build would one day
//! read a record of something it merely *observed*, ignore the field saying so,
//! and take away bytes their owner wrote and the product never posed.
//!
//! Each test works in its own directory: a registry's write puts a temporary and
//! a copy beside it, so two tests sharing a directory would see each other.

use std::fs;
use std::path::PathBuf;

use rigger_apply::SystemLiveness;
use rigger_registry::{transact, Consent, Decision, Proposal, Registry, RegistryError};

/// An empty working directory, private to this test.
fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-format-{name}-{}", std::process::id()));
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

/// A caller that says yes. Consent is a decision handed to the crate, and this
/// crate never reads a terminal.
struct Granting;

impl Consent for Granting {
    fn decide(&self, _: &Proposal<'_>) -> Decision {
        Decision::Granted
    }
}

/// Writes the registry back with no change at all, and answers what the file
/// then holds.
///
/// A write of nothing is what makes "the bytes are kept" observable: the
/// rendering is the only way back out of the reading, and a field dropped at the
/// read disappears here.
fn rewritten(registry: &Registry) -> String {
    transact(registry, &[], &Granting, &SystemLiveness).expect("the transaction must succeed");
    fs::read_to_string(registry.path()).expect("read the registry back")
}

/// One entry line, as the format writes it: the names this build knows, in the
/// order it writes them, then the trace of the behaviour that posed — a store
/// entry, a placement and a fingerprint, carried in one field whose elements are
/// separated by the escape of a tabulation.
fn entry_line(id: &str) -> String {
    format!(
        "entry\tid={id}\tprovenance=acme\tbehaviour=link\tposed_by=1.4\troot=/home/someone\t\
         address={id}.json\tfingerprint=0123456789abcdef\t\
         trace=/store/{id}\\tlink\\t0123456789abcdef"
    )
}

/// A document holding these lines, under the envelope this build writes.
fn document(lines: &[String]) -> String {
    let mut document = String::from("rigger-registry 2\n");
    for line in lines {
        document.push_str(line);
        document.push('\n');
    }
    document
}

/// The one unjudgeable line of a registry, or a failure naming what was read
/// instead.
fn only_unjudgeable(registry: &Registry) -> rigger_registry::Unjudgeable {
    let ledger = registry.read().expect("the read must succeed");
    assert!(
        ledger.entries().is_empty(),
        "the line was read as an entry: {:?}",
        ledger.entries()
    );
    assert_eq!(ledger.unjudgeable().len(), 1);
    ledger.unjudgeable()[0].clone()
}

/// Guard: a document this build wrote reads back as the same records and renders
/// to the same bytes.
///
/// It is the property every other one rests on. A format whose reading and
/// writing disagree loses something on every pass, and the thing it loses is the
/// only description of what is on somebody's machine.
///
/// **What the rendering guarantees, and what it does not.** Entries come out in
/// the order they were read, then the lines that could not be read, in theirs.
/// So a document whose illegible line sits **between** two entries does not come
/// back byte for byte — it comes back with that line moved to the end. That is a
/// property of the rendering and it is left alone here: reordering it belongs to
/// the tolerance A1 grants an entry, not to the shape of the format. The fixture
/// below says which arrangement it is measuring instead of hiding the limit by
/// happening to avoid it.
#[test]
fn guard_a_document_this_build_wrote_reads_back_and_renders_byte_for_byte() {
    // GIVEN a document with two entries and, after them, a line written in some
    // other format altogether.
    const FOREIGN: &str = "entry\tacme/older\tacme\tlink";
    let dir = directory("round-trip");
    let written = format!(
        "{}{FOREIGN}\n",
        document(&[entry_line("acme/one"), entry_line("acme/two")])
    );
    let registry = registry_with(&dir, &written);

    // WHEN it is read.
    let ledger = registry.read().expect("the read must succeed");

    // THEN the two entries are there, with what they carry, and the third line
    // is unjudgeable rather than dropped.
    assert_eq!(ledger.entries().len(), 2);
    assert_eq!(ledger.entries()[0].id(), "acme/one");
    assert_eq!(ledger.entries()[0].provenance(), "acme");
    assert_eq!(ledger.entries()[0].behaviour(), "link");
    assert_eq!(ledger.entries()[0].posed_by(), "1.4");
    assert_eq!(
        ledger.entries()[0].at(),
        std::path::Path::new("/home/someone/acme/one.json")
    );
    assert_eq!(ledger.entries()[0].fingerprint(), "0123456789abcdef");
    assert_eq!(
        ledger.entries()[0].trace(),
        ["/store/acme/one", "link", "0123456789abcdef"]
    );
    assert_eq!(ledger.unjudgeable().len(), 1);

    // AND writing it back produces the same bytes.
    assert_eq!(rewritten(&registry), written);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: the same fields in another order are the same record.
///
/// **This is the half that makes the format extensible rather than renamed.** A
/// build that read the names in a fixed order would still be positional, only
/// with longer field names: inserting anything would break every line already
/// written. No fixture elsewhere writes the fields out of order, and none ever
/// will — they all copy the shape the rendering produces — so a build that
/// silently went back to reading by position would pass the whole suite. This
/// test is the only thing that would not let it.
#[test]
fn guard_a_line_whose_fields_are_permuted_is_the_same_record() {
    let dir = directory("permuted");
    const PERMUTED: &str = "entry\taddress=acme/one.json\ttrace=/store/acme/one\\tlink\\t\
                            0123456789abcdef\tbehaviour=link\tfingerprint=0123456789abcdef\t\
                            root=/home/someone\tid=acme/one\tposed_by=1.4\tprovenance=acme";

    let canonical = registry_with(&dir, &document(&[entry_line("acme/one")]));
    let as_written = canonical.read().expect("the read must succeed");

    let permuted = registry_with(&dir, &document(&[PERMUTED.to_string()]));
    let read_back = permuted.read().expect("the read must succeed");

    assert_eq!(
        read_back.entries(),
        as_written.entries(),
        "the same fields in another order were read as a different record"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: a field this build does not know is kept, handed over, and written
/// back exactly as it was.
///
/// It is the founding rule of this crate turned on its own format. A build that
/// dropped what it does not understand would take the field out of the file at
/// the next write, and a newer build reading that file afterwards would find a
/// record it had written stripped of half of what it said.
///
/// The field is also handed to the caller, so that a reader can name what it
/// found. **Nothing tells the person running the command**, and that is a
/// residual rather than a design: this crate has no channel to say anything at
/// all. The account of it is on the type that carries the field.
#[test]
fn guard_a_field_this_build_does_not_know_is_kept_and_written_back_unchanged() {
    let dir = directory("unknown-field");
    let written = document(&[format!(
        "{}\tlabel=reviewed by hand\tnote=from the 1.9 catalogue",
        entry_line("acme/one")
    )]);
    let registry = registry_with(&dir, &written);

    let ledger = registry.read().expect("the read must succeed");
    assert_eq!(
        ledger.entries().len(),
        1,
        "a field this build does not know made the whole entry unreadable"
    );
    let unknown = ledger.entries()[0].unknown_fields();
    assert_eq!(unknown.len(), 2);
    assert_eq!(unknown[0].name(), "label");
    assert_eq!(unknown[0].value(), "reviewed by hand");
    assert_eq!(unknown[1].name(), "note");
    assert_eq!(unknown[1].value(), "from the 1.9 catalogue");

    // AND the record the entry describes is read exactly as it would be without
    // them: an unknown field is ignored, not merely tolerated.
    assert_eq!(ledger.entries()[0].id(), "acme/one");
    assert_eq!(
        ledger.entries()[0].trace(),
        ["/store/acme/one", "link", "0123456789abcdef"]
    );

    // AND a write that has nothing to do with them puts them back, in order,
    // byte for byte.
    assert_eq!(rewritten(&registry), written);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: a field this build does not know **and that decides how the record is
/// written** makes the entry unjudgeable, naming it.
///
/// **Without this, the extensibility above would be the more destructive of the
/// two defects.** A field that decides a write is not one to ignore: ignoring it
/// means writing something other than what the record declares while believing
/// the declaration is being honoured. The case is not hypothetical — a later
/// version of this format will tell a thing the product *posed* from a thing it
/// merely *observed*, and a build that ignored that field would take away bytes
/// their owner wrote and the product never put there.
///
/// It refuses the **entry** and not the registry: A1 grants its tolerance at the
/// level of one entry, and failing the whole document would lose eleven good
/// records for one this build is too old to read. And an unjudgeable line is
/// written back untouched, so the record survives for the build that does
/// understand it.
#[test]
fn guard_a_field_marked_as_deciding_a_write_makes_the_entry_unjudgeable() {
    let dir = directory("deciding-field");
    let written = document(&[format!("{}\t!kind=observed", entry_line("acme/one"))]);
    let registry = registry_with(&dir, &written);

    let unjudgeable = only_unjudgeable(&registry);
    assert_eq!(unjudgeable.line(), 2);
    assert_eq!(
        unjudgeable.reason(),
        "the field `!kind` decides how this record is to be written, and this build does not \
         carry it — a field of that kind is not one to ignore, because ignoring it means writing \
         something other than what the record declares"
    );

    // AND the line survives the next write, so the build that carries the field
    // still finds the record.
    assert_eq!(rewritten(&registry), written);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: a required field that is not there makes the line unjudgeable, and the
/// reason names it.
///
/// **Never completed from a default.** A default is a value nobody wrote, and a
/// removal computed from one replays a trace against an address nobody
/// consented to — which is the same damage as reading the registry wrong, dressed
/// up as leniency.
#[test]
fn guard_a_required_field_that_is_absent_makes_the_line_unjudgeable_naming_it() {
    let dir = directory("field-absent");
    let registry = registry_with(
        &dir,
        &document(&[
            "entry\tid=acme/one\tprovenance=acme\tbehaviour=link\troot=/home/someone\t\
             address=one.json\tfingerprint=0123456789abcdef"
                .to_string(),
        ]),
    );

    assert_eq!(
        only_unjudgeable(&registry).reason(),
        "the line carries no posing version"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: a name written twice makes the line unjudgeable.
///
/// Nothing here can tell which of the two describes what was posed. Taking the
/// last, or the first, would be choosing at random between two descriptions of
/// something on somebody's machine — and the one not chosen would disappear at
/// the next write.
#[test]
fn guard_a_field_name_written_twice_makes_the_line_unjudgeable() {
    let dir = directory("name-twice");
    let registry = registry_with(
        &dir,
        &document(&[format!("{}\tprovenance=globex", entry_line("acme/one"))]),
    );

    assert_eq!(
        only_unjudgeable(&registry).reason(),
        "the field `provenance` is written twice, and nothing here can tell which of the two \
         describes what was posed"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: a field carrying no `=` makes the line unjudgeable, and the line comes
/// back out whole.
///
/// **It is the outcome that keeps the bytes.** Ignoring such a field would take
/// it out of the file at the next write — the loss this format exists against,
/// on the likeliest case there is: a line written in a format that is not this
/// one at all.
#[test]
fn guard_a_field_carrying_no_separator_makes_the_line_unjudgeable_and_is_written_back() {
    let dir = directory("no-separator");
    let written = document(&[format!("{}\tstray", entry_line("acme/one"))]);
    let registry = registry_with(&dir, &written);

    assert_eq!(
        only_unjudgeable(&registry).reason(),
        "the field `stray` carries no `=`, and every field of an entry is a name and a value"
    );
    assert_eq!(rewritten(&registry), written);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: a value carrying the separator is read whole.
///
/// The name and the value part at the **first** `=` and never the last. Values
/// carry them: a directory called `env=prod` is an ordinary directory, and every
/// path this registry accepts is a path. Cutting at the last one reads back a
/// different root, the entry then names an address nothing was posed at, and the
/// removal that replays its trace finds nothing there — while the whole suite
/// stays green, because no other fixture carries an `=` in a value.
#[test]
fn guard_a_value_carrying_the_separator_is_read_whole() {
    let dir = directory("separator-in-value");
    let written = document(&[
        "entry\tid=acme/one\tprovenance=acme\tbehaviour=link\tposed_by=1.4\t\
         root=/home/someone/env=prod\taddress=deploy=now/one.json\t\
         fingerprint=0123456789abcdef"
            .to_string(),
    ]);
    let registry = registry_with(&dir, &written);

    let ledger = registry.read().expect("the read must succeed");
    assert_eq!(ledger.entries().len(), 1);
    assert_eq!(
        ledger.entries()[0].root(),
        std::path::Path::new("/home/someone/env=prod")
    );
    assert_eq!(
        ledger.entries()[0].address(),
        std::path::Path::new("deploy=now/one.json")
    );
    assert_eq!(
        ledger.entries()[0].at(),
        std::path::Path::new("/home/someone/env=prod/deploy=now/one.json")
    );
    assert_eq!(rewritten(&registry), written);
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard: the format this build replaced is refused, and never migrated.
///
/// The requirement that a registry of an unknown format be refused rather than
/// coerced is realised on a version **above** this one — the case of a build
/// deployed late reading a registry a newer one wrote. The case below is the
/// other side, and it is not the same clause: a version this build once wrote
/// and no longer reads.
///
/// **It is refused and not migrated, and that is a decision.** No registry in
/// version `1` exists outside the working directories of this suite: there is no
/// binary, no command surface and no release. A migration would be code written
/// for a document that does not exist, on the one path where being wrong makes
/// what a machine holds unremovable.
#[test]
fn guard_the_format_this_build_replaced_is_refused_and_not_migrated() {
    let dir = directory("previous-format");
    let written = "rigger-registry 1\nentry\tacme/one\tacme\tlink\t1.4\t/home/someone\t\
                   one.json\tabc\t/store/one\tlink\tdef\n";
    let registry = registry_with(&dir, written);
    let before = fs::read(registry.path()).expect("read the registry file");

    let failure = registry
        .read()
        .expect_err("a registry of the format this build replaced was read as if it were current");

    match &failure {
        RegistryError::EnvelopeUnknown {
            path,
            found,
            expected,
        } => {
            assert_eq!(path, registry.path());
            assert_eq!(found, "1");
            assert_eq!(*expected, 2);
        }
        other => panic!("the refusal does not name the version found: {other}"),
    }

    // AND the file is untouched: a registry of a format this build does not read
    // is the only description of what was posed on that machine, and coercing it
    // would destroy all of it in one gesture.
    assert_eq!(fs::read(registry.path()).expect("read back"), before);
    fs::remove_dir_all(&dir).expect("clean up");
}
