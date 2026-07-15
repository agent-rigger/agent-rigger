---
title: Safety and reversibility
description: "Why everything agent-rigger writes to your machine can be undone: you see a change before it happens, the old file is kept, the install records exactly what it changed, re-runs do nothing new, and two runs at once cannot corrupt each other."
---

agent-rigger changes files on your machine so your AI assistant picks up a shared setup. Every
change it makes to those files can be taken back: you see the change before it happens, the old
version of each file is kept, and the record of what an install did is precise enough to reverse
step by step.

## Two separate questions: is it safe to accept, and can I undo it

A tool that edits your assistant's configuration faces two different risks, and it is worth keeping
them apart. The first is whether the content arriving from a [catalog](/reference/glossary/#catalog)
can be trusted at all: a repository someone can push to might carry a leaked secret or a hostile
command. Deciding what is allowed to reach your disk in the first place, the scanning and the
consent, is the subject of [trust and security](/concepts/trust-and-security/). This page is about
the second risk, which begins only after the tool has decided to write: once it does touch a file,
can everything it wrote be undone. A protection against bad content coming in says nothing about
being able to reverse a change once it is made, so the two are built separately, and this page
takes them in turn.

## Nothing is written before you have seen it

Before an install or a removal touches a single file, the tool assembles a
[plan](/reference/glossary/#plan-dry-run): the exact set of files it would write and rules it would
merge, plus any blocks it would add. It prints that plan and stops there. Nothing is applied until
you confirm.

The alternative is to write first and show a diff afterwards, the way some tools apply and then
report what they did. That was rejected because a change you can only read after it landed is a
change you must undo to reject. Showing the plan first makes refusal cost nothing: you decline the
prompt and the machine is exactly as it was.

The confirmation is also where the reversibility story starts, because a change you approved with
your eyes open is one you already understand well enough to reverse.

## The previous version is kept before it is overwritten

When the tool has to overwrite a file that already exists, a `settings.json` it merges a rule into
or an `AGENTS.md` it edits, it first copies the old content beside it under a
[`.bak-<timestamp>-<token>`](/reference/glossary/#backup-bak) name. That copy is written before the
new content lands, using a staged write that renames the finished copy into place, so a run
interrupted halfway never leaves a truncated backup that looks whole. The recovery file is either
the complete original or absent, never a corrupt middle state.

The name carries a timestamp and a short random token rather than a fixed `.bak`. A single fixed
name would force the tool to probe for an existing backup and either refuse or clobber it; the
random token means two backups of the same file cannot collide, even within the same run, and no
probing loop is needed. The tool keeps these copies rather than clearing them away on its own, on
the reasoning that a recovery file the tool might delete is not one you can rely on.
[doctor](/reference/glossary/#doctor) reports aged ones under its `hygiene` finding class so you can
see them pile up, but deleting them stays your decision.

These backups are also what lets a partly-completed install undo itself. If one artifact in a batch
fails while writing, the engine restores every file it had already overwritten from that file's
backup and deletes the ones it had freshly created, then re-raises the original error, so a failed
install does not leave the machine half-changed.

## The install records exactly what it changed

The reason a later `remove` can undo an install cleanly is that the install wrote down precisely
what it did.

Each entry in the [manifest](/reference/glossary/#manifest) carries an
[applied payload](/reference/glossary/#applied-payload): the resolved mutations the install made,
such as the deny and allow rules it added to a settings file, the canonical content it wrote to
`AGENTS.md`, the [import block](/reference/glossary/#agentsmd-bridge) it added to `CLAUDE.md` so the
assistant reads it, and the hook it registered. `remove` reads that payload and replays each
mutation in reverse.

Recording the payload, rather than re-deriving what to undo at removal time, is what makes `remove`
work offline and exactly. Two alternatives were weighed and set aside. One was to re-fetch the
catalog when removing, so the tool could recompute what a given entry installs; that binds removal
to the network and to the catalog still existing at the same version, a dependency a removal has no
reason to carry. The other was to store a line-by-line textual diff of each file, the way a version
control system would. But these mutations are structured operations with known inverses: removing a rule from a merged
array and stripping a delimited block both reverse cleanly, and so does unregistering a hook. A text
patch buys nothing here and would be harder to apply safely against a file someone has since edited by hand.

Because the mutations to a settings array are merged in with rules from other sources, the tool
cannot tell which array entries are its own by looking at the file alone. The applied payload is
what closes that gap: it names the specific rules this install contributed, so removal takes back
those and leaves everyone else's in place. For a context file the payload goes one step further and
keeps the file's contents from before the first install, so removing the artifact restores that
original text instead of simply deleting the file.

## Running the same install twice changes nothing

Ask the tool to install an artifact that is already correctly in place and it does nothing rather
than installing a second copy. The plan for an already-conforming artifact comes back empty, and an
empty plan is a no-op: nothing is written, no backup made, no new manifest entry. This is
[idempotence](/reference/glossary/#idempotence), and it matters for reversibility because repairing
[drift](/reference/glossary/#drift) means re-running install, and a repair that duplicated or
orphaned rules each time would defeat the point.

A re-install that does have work to do, because a file was edited or a rule went missing, plans only
the part that is missing. If the tool recorded just that partial change as the whole payload, a later
`remove` would take back only the last repair and orphan the rules from earlier runs. So an entry's
applied payload accumulates across runs rather than being replaced: the tool merges the new work into
the payload already on record, keeping the manifest a complete account of everything the entry put in
place, however many runs it took.

## Two runs at once cannot corrupt each other

A single run reads the manifest at the start and holds it in memory while it works, which can
include slow external steps such as installing a plugin through the assistant's own command. Only at
the end does it write the update back. The write itself is atomic, so no reader ever sees a
half-written manifest. That
alone does not stop a second run started in another terminal, or by a hook that re-invokes the CLI,
from writing its own copy over the first one's and silently dropping an entry the first run had just
recorded. A lost entry is not a cosmetic problem: it leaves an artifact that can no longer be
removed, because removal reads the manifest.

To prevent this the tool takes a [run-lock](/reference/glossary/#run-lock) around the window where it
writes. The lock is a file created next to the manifest with an exclusive-create system call, so the
operating system, not the tool, decides which of two racing runs wins; the loser does not wait or
retry but fails fast and prints, verbatim:

```
Another agent-rigger run is in progress (pid 12345). The lockfile is "/home/you/.config/agent-rigger/state.json.lock". Wait for it to finish and retry; if you are sure no run is active, delete the lockfile by hand.
```

The lock records the process that holds it. A run that crashed would otherwise leave its lockfile
behind forever, so a lock is treated as abandoned and broken only when both its age is past a
timeout and the process that wrote it is gone. Judging on both together is deliberate: a
long-running legitimate install, whose process is alive but whose lock has aged, is never broken, and
a very recent crash waits out the timeout so a reused process id cannot trigger a wrongful break.

Two design choices are worth naming. The lock brackets only the writing window, not the whole
command, so it is taken after you confirm the plan; a run left sitting at a confirmation prompt holds
nothing and blocks no one. And because breaking an abandoned lock is itself fallible, the tool does
not rely on the lock alone. Just before writing, it re-reads the manifest from disk and replays its
own changes onto whatever it finds, so an entry another run committed in the meantime survives even
if a lock was broken in error. A read-only command such as `check` takes no lock at all: it writes
nothing, so there is nothing to serialise.

## The limits, stated plainly

Reversibility is only worth claiming if its edges are named.

- **The run-lock protects two agent-rigger runs from each other, not against an outside writer.**
  If the assistant itself rewrites its `settings.json` while the tool holds the lock, the lock does
  nothing about it. Its scope is concurrent runs of this tool on one machine.
- The warning printed when a stale lock is broken does not reach every command today. `remove`
  prints it; `install`, the command this page's examples use, breaks an identical stale lock
  silently. The staleness check itself, age past the timeout and the process gone, runs the same way
  regardless; only the notice differs.
- A re-install that fails partway is undone to be orphan-safe, not byte-for-byte. Files it overwrote
  are restored from their backups, and anything a fresh install created is removed. But when the
  failed run was re-installing an already-tracked artifact, the managed directories it touched are
  not rolled back to their earlier contents; they are recreatable by running install again, so the
  recovery is to re-run, not to expect the previous bytes back.
- Delegated steps cannot always be fully reversed. When installation is handed to the assistant's
  own command, for a plugin for instance, the compensating uninstall is best-effort and does not
  undo everything the delegated command did, such as registering a marketplace. The tool reports
  what it could not reverse rather than pretending it did.
- A file you edited by hand is left alone, not overwritten back. When removal would restore a
  context file to its pre-install text but the file has since drifted from what the tool recorded,
  the tool leaves your version in place rather than discarding your edit. Reversibility never means
  the tool silently reclaims a file you have made your own.

## Next

- See how content is judged before any of this writing begins, in
  [trust and security](/concepts/trust-and-security/).
- Read how the tool separates what is available, installed, and on disk in
  [core concepts](/concepts/core-concepts/).
- See the [exit codes](/reference/exit-codes/) a script reacts to, including a run that failed
  because another was in progress.
- Look up any term in the [glossary](/reference/glossary/).
