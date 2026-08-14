//! Posing a whole directory on a real disk, and taking it back off.
//!
//! A test prefixed with an identifier realises that requirement. A4 — an
//! interrupted transaction gives back the state that preceded it, which for a
//! directory means the directory itself is gone, not emptied. MD-71 — a symbolic
//! link inside a tree is refused before any file operation, at any depth.
//!
//! Those prefixed with `guard_` realise no requirement: they state what the two
//! above rest on — a pose that leaves nothing visible when it fails in the
//! middle, and a removal that refuses a tree somebody else has changed.
//!
//! **The interruption is a place in the sequence, not a killed process.** A
//! harness that killed a process would have to hit a window nothing
//! deterministic schedules, and would be green on broken code most times it ran.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};

use rigger_apply::{
    pose, read_tree, withdraw, OnDisk, PoseError, StepError, Steps, SystemPracticability,
};
use rigger_plan::{BehaviourName, Effect, Fragment, Placement, Referents, Trace, Tree, TreeEntry};

/// A working directory holding the two places a pose needs to exist already: the
/// root it writes under, and the shared store. The product makes neither — the
/// one directory it creates is the address of the tree itself.
fn machine(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-tree-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(path.join("root/skills")).expect("create the root");
    fs::create_dir_all(path.join("store")).expect("create the shared store");
    path
}

fn entry(name: &str, contents: &str) -> TreeEntry {
    TreeEntry {
        name: name.to_string(),
        contents: contents.to_string(),
        executable: false,
    }
}

/// The shape the reference catalogue's skills have: files at the root of the
/// tree and files one directory down. A flat tree would leave unmeasured the
/// directories a plant has to create inside the transit area.
fn skill() -> Tree {
    Tree::of(vec![
        entry("SKILL.md", "# Graphify\n"),
        entry("references/queries.md", "## Queries\n"),
    ])
}

fn fragment(store: &Path, entries: Tree, placement: Placement) -> Fragment {
    Fragment::Tree {
        store: store.to_path_buf(),
        entries,
        placement,
    }
}

/// Everything under `base`, as names and as what each name holds — the
/// comparison "the machine is as it was" is made of.
fn snapshot(base: &Path) -> Vec<(String, String)> {
    fn walk(base: &Path, directory: &Path, found: &mut Vec<(String, String)>) {
        let mut paths: Vec<PathBuf> = fs::read_dir(directory)
            .expect("read the directory")
            .map(|entry| entry.expect("read the entry").path())
            .collect();
        paths.sort();
        for path in paths {
            let named = path
                .strip_prefix(base)
                .expect("a path under the base")
                .display()
                .to_string();
            let metadata = fs::symlink_metadata(&path).expect("read the metadata");
            if metadata.file_type().is_symlink() {
                let to = fs::read_link(&path).expect("read the link");
                found.push((named, format!("link -> {}", to.display())));
            } else if metadata.is_dir() {
                found.push((named, "directory".to_string()));
                walk(base, &path, found);
            } else {
                let bytes = fs::read(&path).expect("read the file");
                found.push((named, format!("file {bytes:?}")));
            }
        }
    }

    let mut found = Vec::new();
    walk(base, base, &mut found);
    found
}

/// Carries every step out on the real disk, and reports the chosen one failed
/// **after** it landed — which is what an interruption looks like from inside a
/// transaction: the change is on the machine and the run does not reach the
/// next step. Failing *before* carrying it out would measure something easier, a
/// transaction with nothing to give back.
struct FailsAfter {
    step: usize,
    seen: Cell<usize>,
}

impl Steps for FailsAfter {
    fn carry_out(&self, effect: &Effect) -> Result<(), StepError> {
        let seen = self.seen.get();
        self.seen.set(seen + 1);
        OnDisk.carry_out(effect)?;
        if seen == self.step {
            return Err(StepError::Occupied {
                address: effect.address().to_path_buf(),
            });
        }
        Ok(())
    }
}

#[test]
fn guard_a_tree_posed_and_then_withdrawn_leaves_the_machine_as_it_was() {
    let machine = machine("round-trip");
    let address = machine.join("root/skills/graphify");
    let store = machine.join("store/acme-graphify-1.0");
    let before = snapshot(&machine);

    let posted = pose(
        BehaviourName::Link,
        &address,
        &fragment(&store, skill(), Placement::Copy),
        &OnDisk,
        &SystemPracticability,
    )
    .expect("the pose must succeed");

    assert_eq!(
        fs::read_to_string(address.join("references/queries.md")).expect("the nested file"),
        "## Queries\n",
        "a tree posed by copy puts every one of its files at the address, nested ones included"
    );

    withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect("the removal must succeed");

    assert_eq!(
        snapshot(&machine),
        before,
        "the promise is the disk as it was — not the files gone with the directory left standing"
    );
}

#[test]
fn a4_a_pose_interrupted_after_planting_leaves_no_directory_where_there_was_none() {
    // The change `Seized::Directory` exists for: a directory the run created has
    // to be given back as the absence that preceded it. Before there was a state
    // to seize at a directory address, this rollback had nothing to give back —
    // which is why the product refused to create a directory at all.
    let machine = machine("interrupted-pose");
    let address = machine.join("root/skills/graphify");
    let store = machine.join("store/acme-graphify-1.0");
    let before = snapshot(&machine);

    let refusal = pose(
        BehaviourName::Link,
        &address,
        &fragment(&store, skill(), Placement::Copy),
        &FailsAfter {
            step: 1,
            seen: Cell::new(0),
        },
        &SystemPracticability,
    )
    .expect_err("the second step reports a failure after it landed");

    assert!(
        matches!(refusal, PoseError::RolledBack { step: 1, .. }),
        "the machine must be reported as given back: {refusal}"
    );
    assert_eq!(
        snapshot(&machine),
        before,
        "both directories the run created must be gone, and gone whole"
    );
}

#[test]
fn guard_a_plant_that_fails_in_the_middle_leaves_nothing_at_the_destination() {
    // The transit area, measured. This tree cannot be built: `a` is a file, and
    // `a/b` then needs `a` to be a directory — so the plant fails after one file
    // has already been written. Written straight into its final directory, that
    // leaves a visible half-tree at the address; built beside it and renamed,
    // there is never anything at the address to be half of.
    let machine = machine("half-tree");
    let address = machine.join("root/skills/graphify");

    let refusal = OnDisk
        .carry_out(&Effect::Plant {
            address: address.clone(),
            entries: Tree::of(vec![
                entry("a", "written first\n"),
                entry("a/b", "then this\n"),
            ]),
        })
        .expect_err("this tree cannot be built");

    assert!(
        matches!(refusal, StepError::Io { .. }),
        "the refusal must name what the system reported: {refusal}"
    );
    assert!(!address.exists(), "nothing may be visible at the address");
    assert_eq!(
        snapshot(&machine.join("root/skills")),
        Vec::new(),
        "and the transit area must not be left beside it either"
    );
}

#[test]
fn md71_a_symbolic_link_at_depth_two_is_refused_before_anything_is_written() {
    // MD-71 requires a symbolic link in a source tree to be refused before any
    // file operation, at any depth. The reference catalogue carries none today,
    // which is exactly why the guard is writable now and would be unprovable
    // once one existed. The link here is two levels down, where a walk that only
    // checked the top of the tree would miss it.
    let machine = machine("symbolic-link");
    let source = machine.join("source/graphify");
    fs::create_dir_all(source.join("references")).expect("create the source tree");
    fs::write(source.join("SKILL.md"), "# Graphify\n").expect("write the source file");
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/passwd", source.join("references/elsewhere.md"))
        .expect("place the link");
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(
        "C:/Windows/System32/drivers/etc/hosts",
        source.join("references/elsewhere.md"),
    )
    .expect("place the link");
    let before = snapshot(&machine.join("root"));

    let refusal = read_tree(&source).expect_err("a tree carrying a link is refused");

    match refusal {
        StepError::SymbolicLink { address } => assert_eq!(
            address,
            source.join("references/elsewhere.md"),
            "the refusal must name the link it found"
        ),
        other => panic!("expected the link to be named, got {other}"),
    }
    assert_eq!(
        snapshot(&machine.join("root")),
        before,
        "the tree is read before the pose is computed, so nothing can have been written"
    );
}

#[test]
fn guard_a_tree_a_file_was_added_to_is_not_uprooted_and_the_refusal_names_the_divergence() {
    let machine = machine("altered-tree");
    let address = machine.join("root/skills/graphify");
    let store = machine.join("store/acme-graphify-1.0");

    let posted = pose(
        BehaviourName::Link,
        &address,
        &fragment(&store, skill(), Placement::Copy),
        &OnDisk,
        &SystemPracticability,
    )
    .expect("the pose must succeed");
    fs::write(address.join("notes.md"), "mine, not the product's\n").expect("the user writes");

    let refusal = withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect_err("this is no longer the tree that was planted");

    let named = refusal.to_string();
    assert!(
        named.contains(&address.display().to_string()),
        "the refusal must name the directory it left alone: {named}"
    );
    let Trace::Tree { posed, .. } = posted.trace else {
        panic!("a tree pose records a tree trace");
    };
    assert!(
        named.contains(&posed.to_string()),
        "and the fingerprint it was expecting: {named}"
    );
    assert!(
        address.join("notes.md").exists() && address.join("SKILL.md").exists(),
        "it deletes nothing it did not write, and leaves no half-emptied directory"
    );
    assert!(
        store.exists(),
        "and the store tree stays, the removal having refused before reaching it"
    );
}

#[test]
fn guard_planting_the_same_tree_twice_changes_nothing_and_a_different_one_refuses() {
    // The pair, and it is the pair that has teeth. Planting over an identical
    // tree has to do nothing, or two things asking for one store entry would see
    // the second pose replace what the first planted — for an instant, and for
    // good if it then failed. Planting over a *different* one has to refuse, or
    // the same gesture would silently destroy a tree the product never read.
    let machine = machine("second-plant");
    let store = machine.join("store/acme-graphify-1.0");
    let planted = Effect::Plant {
        address: store.clone(),
        entries: skill(),
    };
    OnDisk
        .carry_out(&planted)
        .expect("the first plant must succeed");
    let after_the_first = snapshot(&machine);

    OnDisk
        .carry_out(&planted)
        .expect("the same tree again must be a step with nothing to do");
    assert_eq!(snapshot(&machine), after_the_first);

    let refusal = OnDisk
        .carry_out(&Effect::Plant {
            address: store.clone(),
            entries: Tree::of(vec![entry("SKILL.md", "# Something else entirely\n")]),
        })
        .expect_err("another tree at the same address is refused");

    assert!(
        matches!(refusal, StepError::Occupied { address } if address == store),
        "the refusal must name the address it left alone: {}",
        store.display()
    );
    assert_eq!(
        snapshot(&machine),
        after_the_first,
        "and the tree that was there must be untouched, down to its nested file"
    );
}

/// Whether the file at `path` is one this machine would run — read straight off
/// the disk rather than through the crate's own `is_executable`, so a mutation
/// of that function cannot leave the assertions below agreeing with it and with
/// nothing else.
#[cfg(unix)]
fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .expect("read the mode")
        .permissions()
        .mode()
        & 0o111
        != 0
}

/// A source directory holding one file the machine would run and one it would
/// not — the shape a catalogue distributing a hook has, and the one the
/// reference catalogue does not: 73 files, no executable bit among them.
#[cfg(unix)]
fn source_with_a_script(machine: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let source = machine.join("source/graphify");
    fs::create_dir_all(source.join("scripts")).expect("create the source tree");
    fs::write(source.join("SKILL.md"), "# Graphify\n").expect("write the plain file");
    let script = source.join("scripts/build.sh");
    fs::write(&script, "#!/bin/sh\nexit 0\n").expect("write the script");
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("make it runnable");
    source
}

#[test]
#[cfg(unix)]
fn guard_a_source_script_is_read_as_runnable_and_planted_runnable() {
    // The defect: a source in 755 was posed in 644 and nothing said so, the
    // reader finding out at execution, far from the pose. Both halves are
    // measured — the walk has to see the bit and the plant has to write it —
    // because either one dropping it fails identically for that reader.
    let machine = machine("executable-source");
    let address = machine.join("root/skills/graphify");
    let store = machine.join("store/acme-graphify-1.0");
    let source = source_with_a_script(&machine);

    let entries = read_tree(&source).expect("the source tree must be readable");

    assert_eq!(
        entries
            .entries()
            .iter()
            .map(|entry| (entry.name.as_str(), entry.executable))
            .collect::<Vec<_>>(),
        vec![("SKILL.md", false), ("scripts/build.sh", true)],
        "the walk must carry each file's executable bit, and only where it stands"
    );

    let posted = pose(
        BehaviourName::Link,
        &address,
        &fragment(&store, entries, Placement::Copy),
        &OnDisk,
        &SystemPracticability,
    )
    .expect("the pose must succeed");
    // The trace is what a removal replays, and dropping it is what the type
    // refuses — held here rather than ignored, so the refusal keeps its teeth.
    assert!(matches!(posted.trace, Trace::Tree { .. }));

    assert!(
        runnable(&address.join("scripts/build.sh")),
        "a script the catalogue distributes must be runnable where it was posed"
    );
    assert!(
        !runnable(&address.join("SKILL.md")),
        "and a file that was not runnable must not have become one — the bit is carried, not \
         handed out"
    );
    assert!(
        runnable(&store.join("scripts/build.sh")),
        "the store tree is what a pose by link designates, so it carries the bit too"
    );
}

#[test]
#[cfg(unix)]
fn guard_a_tree_whose_mode_the_user_changed_is_not_uprooted_and_the_refusal_names_the_divergence() {
    // The consequence ADR-0050 takes on rather than hides: with the bit under
    // the fingerprint, a `chmod` by the owner makes the removal refuse — the
    // same answer, in the same words, adding a file to the tree already gets.
    // The owner restores the mode and withdraws, having lost nothing.
    use std::os::unix::fs::PermissionsExt;

    let machine = machine("chmodded-tree");
    let address = machine.join("root/skills/graphify");
    let store = machine.join("store/acme-graphify-1.0");
    let source = source_with_a_script(&machine);
    let entries = read_tree(&source).expect("the source tree must be readable");

    let posted = pose(
        BehaviourName::Link,
        &address,
        &fragment(&store, entries, Placement::Copy),
        &OnDisk,
        &SystemPracticability,
    )
    .expect("the pose must succeed");
    let script = address.join("scripts/build.sh");
    // `u-x`, not the whole of `0o111`: a reading answering "any of the three
    // bits" answers the same before and after this line, so the tree
    // fingerprinted identically and was taken back as though nothing had
    // changed it — while the owner, who this machine runs as, could no longer
    // run the file.
    fs::set_permissions(&script, fs::Permissions::from_mode(0o655)).expect("the user chmods");

    let refusal = withdraw(
        BehaviourName::Link,
        &address,
        &posted.trace,
        Referents::Last,
        &OnDisk,
    )
    .expect_err("this is no longer the tree that was planted");

    let named = refusal.to_string();
    assert!(
        named.contains(&address.display().to_string()),
        "the refusal must name the directory it left alone: {named}"
    );
    let Trace::Tree { posed, .. } = posted.trace else {
        panic!("a tree pose records a tree trace");
    };
    assert!(
        named.contains(&posed.to_string()),
        "and the fingerprint it was expecting: {named}"
    );
    assert!(
        script.exists() && address.join("SKILL.md").exists(),
        "it deletes nothing, and leaves no half-emptied directory"
    );
}

#[test]
fn guard_a_tree_naming_a_file_outside_itself_is_refused_before_anything_is_written() {
    let machine = machine("escaping-name");
    let address = machine.join("root/skills/graphify");
    let before = snapshot(&machine);

    let refusal = OnDisk
        .carry_out(&Effect::Plant {
            address: address.clone(),
            entries: Tree::of(vec![entry("../../escaped.md", "somewhere else\n")]),
        })
        .expect_err("a name that leaves the tree is refused");

    match refusal {
        StepError::EscapesTheTree { address: named, .. } => assert_eq!(named, address),
        other => panic!("expected the escaping name to be refused, got {other}"),
    }
    assert_eq!(
        snapshot(&machine),
        before,
        "the bytes must not have landed anywhere, inside the tree or above it"
    );
}
