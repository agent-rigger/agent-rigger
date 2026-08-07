//! A3 — the exclusion between runs, in the decisions it takes.
//!
//! A test prefixed with an identifier realises that requirement. Two of its
//! scenarios are decisions rather than races, and they are what this file
//! measures: **an indeterminate liveness is refused by naming the
//! indeterminacy and its reason, and never folded onto "dead"**, and **breaking
//! an expired lock is an exchange conditioned on the identity of what was
//! observed, never a bare removal**.
//!
//! The liveness of a holder is provided rather than asked of the system here,
//! and that is deliberate. Manufacturing a real indeterminate answer needs a
//! live process belonging to another user; the obvious candidate answers "alive"
//! when the suite runs as root, which most containers do. A test written against
//! the system probe would be green on a developer's machine and green on a build
//! machine while measuring nothing on one of them, with nothing to say so.
//!
//! A stale lock is manufactured by **writing the moment of acquisition** into
//! the lock, which is exact and needs no waiting. The format is written out here
//! rather than produced by the code under test: a fixture built by that code
//! would agree with it whatever either of them did.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rigger_apply::lock::{seconds_since_epoch, VALIDITY};
use rigger_apply::{Liveness, LivenessProbe, Lock, LockError, SystemLiveness};

/// An empty working directory, private to this test.
fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("rigger-lock-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create the working directory");
    path
}

/// A probe that answers the same thing about every process.
struct Answers(Liveness);

impl LivenessProbe for Answers {
    fn liveness(&self, _pid: u32) -> Liveness {
        self.0.clone()
    }
}

/// Writes a lock recording `pid` as having taken it `age` ago.
fn lock_taken_ago(lock: &Lock, pid: u32, age: Duration) -> String {
    let taken_at = seconds_since_epoch().saturating_sub(age.as_secs());
    let identity = format!("rigger-lock 1 {pid} {taken_at}\n");
    fs::write(lock.path(), &identity).expect("write the lock");
    identity
}

/// The lock of a registry that does not need to exist: the exclusion is a path
/// derived from the registry's, and deriving it reads nothing.
fn lock_in(dir: &Path) -> Lock {
    Lock::beside(&dir.join("registry"))
}

#[test]
fn a3_a_holder_whose_liveness_cannot_be_determined_is_named_and_the_lock_is_left_alone() {
    // GIVEN a lock whose validity has run out, held by a process the liveness
    // test refuses to answer about.
    let dir = directory("undetermined");
    let lock = lock_in(&dir);
    let identity = lock_taken_ago(&lock, 4242, VALIDITY + Duration::from_secs(60));
    const REPORTED: &str = "Operation not permitted (os error 1)";

    // WHEN a run tries to take it.
    let failure = lock
        .acquire(&Answers(Liveness::Undetermined {
            reason: REPORTED.to_string(),
        }))
        .expect_err("an indeterminate holder was treated as one this run could act on");

    // THEN it refuses while naming the indeterminacy and its reason.
    match &failure {
        LockError::UndeterminedHolder { path, pid, reason } => {
            assert_eq!(path, lock.path());
            assert_eq!(*pid, 4242);
            assert_eq!(reason, REPORTED);
        }
        other => panic!("the refusal does not name the indeterminacy: {other}"),
    }
    assert!(failure.to_string().contains(REPORTED));

    // AND it does NOT break the lock. The same answer comes back for a living
    // run belonging to another user, so folding it onto "dead" would break a
    // living run's lock and open two writers onto one owned document.
    assert_eq!(
        fs::read_to_string(lock.path()).expect("read the lock back"),
        identity
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_a_lock_past_its_validity_whose_holder_is_dead_is_broken_and_taken() {
    // GIVEN a lock past its validity whose holder is observed dead.
    let dir = directory("expired-and-dead");
    let lock = lock_in(&dir);
    lock_taken_ago(&lock, 4242, VALIDITY + Duration::from_secs(60));

    // WHEN a run takes it.
    let held = lock
        .acquire(&Answers(Liveness::Dead))
        .expect("a lock left behind by a crashed run kept the registry to itself for good");

    // THEN it is ours, and the lock now records this run.
    assert_eq!(held.path(), lock.path());
    let identity = fs::read_to_string(lock.path()).expect("read the lock back");
    assert!(
        identity.contains(&format!(" {} ", std::process::id())),
        "the lock does not record the run that took it: {identity}"
    );

    // AND abandoning it releases the exclusion.
    drop(held);
    assert!(
        !lock.path().exists(),
        "the lock outlived the run holding it"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_a_lock_within_its_validity_is_not_broken_even_when_its_holder_is_dead() {
    // GIVEN a lock taken a moment ago, whose holder is observed dead — a run
    // that has just crashed, or a process identifier the system has since given
    // to somebody else.
    let dir = directory("fresh-and-dead");
    let lock = lock_in(&dir);
    let identity = lock_taken_ago(&lock, 4242, Duration::from_secs(0));

    // WHEN a run tries to take it.
    let failure = lock
        .acquire(&Answers(Liveness::Dead))
        .expect_err("a lock was broken on death alone, with no validity run out");

    // THEN it refuses. Expiry and death are two conditions, not one: on death
    // alone, a recycled process identifier is enough to have a live run's lock
    // taken away from it.
    assert!(
        matches!(&failure, LockError::Held { pid, .. } if *pid == 4242),
        "the refusal does not name the run that holds it: {failure}"
    );
    assert_eq!(
        fs::read_to_string(lock.path()).expect("read the lock back"),
        identity
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_a_lock_within_its_validity_is_not_broken_through_the_break_path_either() {
    // The twin of the test above, taken through the two public gestures a break
    // is made of rather than through the acquisition that assembles them.
    //
    // It exists because the conjunction — validity run out AND holder dead —
    // used to be assembled by `acquire` alone. A caller following the documented
    // protocol to the letter, observe then break, checked the death and skipped
    // the expiry, and took a lock one second old away from the run holding it.
    // No test of the assembled path could go red on that, because the assembled
    // path was correct.
    let dir = directory("fresh-through-break");
    let lock = lock_in(&dir);
    let identity = lock_taken_ago(&lock, 4242, Duration::from_secs(0));

    // WHEN the first gesture of a break runs on it.
    let observed = lock
        .observe()
        .expect("the observation must succeed")
        .expect("there must be a lock to observe");
    let failure = observed
        .past_validity()
        .expect_err("a lock well inside its validity was handed over as breakable");

    // THEN it names the run that holds it, and there is no value with which the
    // second gesture could have been called: `break_if_unchanged` takes what
    // this refuses to produce, so the wrong wiring does not compile. The doc of
    // `Lock::break_if_unchanged` carries that pair as doctests.
    assert!(
        matches!(&failure, LockError::Held { pid, .. } if *pid == 4242),
        "the refusal does not name the run that holds it: {failure}"
    );
    assert_eq!(
        fs::read_to_string(lock.path()).expect("read the lock back"),
        identity
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_a_lock_recreated_between_the_observation_and_the_break_is_not_overwritten() {
    // GIVEN an expired lock, observed.
    let dir = directory("conditioned-break");
    let lock = lock_in(&dir);
    lock_taken_ago(&lock, 4242, VALIDITY + Duration::from_secs(60));
    let expired = lock
        .observe()
        .expect("the observation must succeed")
        .expect("there must be a lock to observe")
        .past_validity()
        .expect("the lock is past its validity");

    // AND a third party that takes that path for itself in between.
    let by_a_third_party = lock_taken_ago(&lock, 5353, Duration::from_secs(0));

    // WHEN the break runs.
    let failure = lock
        .break_if_unchanged(expired, &Answers(Liveness::Dead))
        .expect_err(
            "the break was unconditional and destroyed a lock somebody else had just taken",
        );

    // THEN it refuses, and the third party's lock is still there, byte for byte.
    // A bare removal followed by a creation leaves a window in which exactly
    // this happens, and reopens the two concurrent writers the exclusion exists
    // to close.
    assert!(
        matches!(&failure, LockError::IdentityChanged { path } if path == lock.path()),
        "the break did not condition itself on what was observed: {failure}"
    );
    assert_eq!(
        fs::read_to_string(lock.path()).expect("read the lock back"),
        by_a_third_party
    );
    assert_eq!(
        files(&dir),
        vec!["registry.lock".to_string()],
        "the break left something beside the lock"
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_a_lock_nothing_has_touched_since_it_was_observed_is_broken_and_taken() {
    // The positive twin of the test above: without it, a break that always
    // refused would pass that one and measure nothing.
    let dir = directory("unchanged-break");
    let lock = lock_in(&dir);
    lock_taken_ago(&lock, 4242, VALIDITY + Duration::from_secs(60));
    let expired = lock
        .observe()
        .expect("the observation must succeed")
        .expect("there must be a lock to observe")
        .past_validity()
        .expect("the lock is past its validity");

    let held = lock
        .break_if_unchanged(expired, &Answers(Liveness::Dead))
        .expect("a lock nothing had touched was refused");
    assert_eq!(held.path(), lock.path());
    assert_eq!(
        files(&dir),
        vec!["registry.lock".to_string()],
        "the break left something beside the lock"
    );
    drop(held);
    fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn a3_a_living_holder_is_refused_at_the_moment_of_acting() {
    // The verdict taken when a lock was judged breakable describes a process
    // that has had time to change state, so it is taken again here.
    let dir = directory("alive-at-acting");
    let lock = lock_in(&dir);
    let identity = lock_taken_ago(&lock, 4242, VALIDITY + Duration::from_secs(60));
    let expired = lock
        .observe()
        .expect("the observation must succeed")
        .expect("there must be a lock to observe")
        .past_validity()
        .expect("the lock is past its validity");

    let failure = lock
        .break_if_unchanged(expired, &Answers(Liveness::Alive))
        .expect_err("the lock of a living run was broken");

    assert!(matches!(&failure, LockError::Held { pid, .. } if *pid == 4242));
    assert_eq!(
        fs::read_to_string(lock.path()).expect("read the lock back"),
        identity
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: a file at the lock's path that does not read as a lock
/// has neither a holder nor an age, so neither condition of a break can be
/// judged. It is left in place and named — the arm that refuses rather than the
/// one that is convenient.
#[test]
fn guard_a_lock_that_does_not_read_is_named_and_left_in_place() {
    let dir = directory("unreadable-lock");
    let lock = lock_in(&dir);
    const NOT_A_LOCK: &str = "whatever somebody put here\n";
    fs::write(lock.path(), NOT_A_LOCK).expect("write the file");

    let failure = lock
        .acquire(&Answers(Liveness::Dead))
        .expect_err("a file nobody could read was treated as a breakable lock");

    assert!(
        matches!(&failure, LockError::Unreadable { path, .. } if path == lock.path()),
        "the refusal does not name what could not be read: {failure}"
    );
    assert_eq!(
        fs::read_to_string(lock.path()).expect("read it back"),
        NOT_A_LOCK
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: a file of zero bytes at the lock's path, and the reason
/// it is refused rather than broken — which is worth writing down, because
/// refusing it means the registry it guards stays unwritable until somebody
/// removes the file by hand.
///
/// It records no holder and no moment of acquisition, so **neither** condition
/// of a break can be judged; breaking it would be deciding about a file nothing
/// is known of. The tempting fallback — judging its age by the file's own
/// modification time — is worse than the state it repairs. `Unreadable` is also
/// what a lock written by a **newer** build looks like to this one, so that
/// fallback would let an old build destroy the live lock of a new one, on a
/// timestamp anything on the machine rewrites. That is the fold this module
/// refuses everywhere else, restated on the age instead of on the liveness.
///
/// What is closed instead is the **manufacture** of the state: the lock's name
/// is published by linking a file already written and forced to the disk, so no
/// interruption of this product leaves zero bytes at that path. The test below
/// measures that half.
#[test]
fn guard_an_empty_file_at_the_lock_path_is_named_and_left_in_place() {
    let dir = directory("empty-lock");
    let lock = lock_in(&dir);
    fs::write(lock.path(), b"").expect("write the empty file");

    let failure = lock
        .acquire(&Answers(Liveness::Dead))
        .expect_err("a file nothing could be judged about was treated as a breakable lock");

    match &failure {
        LockError::Unreadable { path, reason } => {
            assert_eq!(path, lock.path());
            assert_eq!(reason, "it is empty");
        }
        other => panic!("the refusal does not name what could not be read: {other}"),
    }
    assert_eq!(
        fs::read(lock.path()).expect("read it back"),
        Vec::<u8>::new()
    );
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: what this build itself leaves at the lock's path.
///
/// Two things, and the first is the one that used to fail. **A lock this build
/// published reads back as a lock**: created empty and written into afterwards,
/// the path holds zero bytes for a window, and a run killed inside it — or a
/// full disk, or a power cut — leaves the file the guard above refuses to
/// break, for ever, by the product's own hand. So the second acquisition below
/// must be refused as `Held` and never as `Unreadable`.
///
/// **And a refused acquisition leaves nothing beside it.** The content is
/// written to a file next to the lock before being linked into place; forgotten
/// there, every refused acquisition would drop one more file into the directory
/// the registry lives in.
#[test]
fn guard_a_published_lock_reads_back_as_one_and_a_refused_one_leaves_no_residue() {
    let dir = directory("published-whole");
    let lock = lock_in(&dir);
    let held = lock
        .acquire(&SystemLiveness)
        .expect("the first acquisition must succeed");

    let failure = lock
        .acquire(&SystemLiveness)
        .expect_err("two runs held the same registry at once");
    assert!(
        matches!(&failure, LockError::Held { pid, .. } if *pid == std::process::id()),
        "the lock this build wrote does not read back as one: {failure}"
    );
    assert_eq!(
        files(&dir),
        vec!["registry.lock".to_string()],
        "the acquisition left something beside the lock"
    );

    drop(held);
    assert_eq!(files(&dir), Vec::<String>::new());
    fs::remove_dir_all(&dir).expect("clean up");
}

/// Guard, not scenario: two acquisitions of the same lock, the second refused
/// fast. Without it, every measurement above would still pass on an exclusion
/// that excludes nothing.
#[test]
fn guard_a_second_acquisition_is_refused_and_never_waits() {
    let dir = directory("mutual-exclusion");
    let lock = lock_in(&dir);
    let held = lock
        .acquire(&SystemLiveness)
        .expect("the first acquisition must succeed");

    let failure = lock
        .acquire(&SystemLiveness)
        .expect_err("two runs held the same registry at once");
    assert!(matches!(&failure, LockError::Held { .. }), "{failure}");

    drop(held);
    lock.acquire(&SystemLiveness)
        .expect("the lock was not released");
    fs::remove_dir_all(&dir).expect("clean up");
}

/// A characterization of the machine, not of a decision — and it is kept apart
/// for that reason. What the product decides on an indeterminate holder is
/// measured above, through a provided verdict; whether the system probe really
/// answers `Undetermined` on a permission refusal depends on who the suite runs
/// as, and no assertion here would hold on every machine. What does hold
/// everywhere is that the process asking is alive.
#[test]
fn characterization_the_system_probe_finds_the_running_process_alive() {
    assert_eq!(
        SystemLiveness.liveness(std::process::id()),
        Liveness::Alive,
        "the probe cannot see the process that is asking"
    );
}

/// The files present in a directory, sorted.
fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("read the directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}
