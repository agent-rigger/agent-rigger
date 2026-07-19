---
title: Publish a pack
description: "Group several artifacts under one id so a team installs a coherent set in one step: the pack entry shape, what its members are, how required/recommended and targets/scopes apply, and what the installer shows."
---

A [pack](/reference/glossary/#pack) is a catalog entry that groups other entries under one id, so a
teammate installs a coherent set (say a spec-workflow's sub-agent bundled with its skill and its
guardrail) in a single step instead of naming each artifact. This how-to covers the pack entry: its
exact shape, what its `members` hold, how the three senses of _required_ reach a pack, and what the
installer puts on screen when someone selects one.

It does not re-teach the authoring loop. Making the catalog repository and committing to it, then
cutting a version tag, is the same for a pack as for any entry. See
[create a catalog](/authoring/create-a-catalog/). A pack adds no files of its own to the repository;
its members carry the content.

## The pack entry

A pack is an entry with `kind: "pack"`. It shares the [common fields](/reference/catalog-schema/#common-fields)
every entry has (`id`, `targets`, `scopes`, and optional `requires`) and adds exactly one field of
its own, `members`:

```json title="entry in catalog.json"
{
  "kind": "pack",
  "id": "pack:demo",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "members": ["skill:hello-rigger", "agent:demo"]
}
```

`members` is a **non-empty array of entry ids**: plain strings, not nested objects. Each id names
another entry in the same `catalog.json`. The pack holds no `nature` or `check`, and no `install`: it
is a bundle of references, and the referenced entries hold the installable content.

A pack is parsed in **strict mode**. Any field beyond `kind`, `id`, `targets`, `scopes`, `requires`,
and `members` is rejected, including `nature`, which belongs on an [artifact](/reference/glossary/#artifact)
entry, never on a pack. The full field table is in the [pack entries reference](/reference/catalog-schema/#pack-entries).

## What a pack can group

A member id can point at an artifact of any of the eight [natures](/reference/glossary/#nature), or
at another pack. When the installer expands a selection, a pack member that is itself a pack is
expanded in turn, recursively; the packs themselves are never installed, only the artifacts they
resolve to. So a broad pack can be composed from narrower ones:

```json title="entry in catalog.json"
{
  "kind": "pack",
  "id": "pack:full",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "members": [
    "skill:hello-rigger",
    "agent:demo",
    "guardrail:demo",
    "hook:demo",
    "context:demo"
  ]
}
```

A pack may also carry its own `requires`. Those ids are resolved alongside the members, following
the same [requires](/reference/glossary/#requires) chain any entry does. What each nature actually
writes on disk, per assistant and scope, is the [natures × assistants × scopes](/reference/natures-matrix/)
contract. The pack changes nothing about that: it only decides which artifacts enter the
transaction together.

## A member that points at nothing

The parser performs **no referential check** on `members`. A pack whose member id matches no entry
parses cleanly and lists cleanly. The mismatch is not caught at read time:

```
Catalog (2 entries):
  [available]  demoteam/skill:present  skill  
  [available]  demoteam/pack:sampler   pack   (2 members)
```

The gap surfaces at install time, when the installer resolves the pack to concrete artifacts and
finds the id absent:

```
[error] Unknown artifact: Unknown catalog entry: "skill:ghost" (required by: pack:sampler)
```

The run stops with [exit code](/reference/exit-codes/) `2` and writes nothing. The `(required by:
pack:sampler)` chain names the pack that referenced the missing id, so a typo in `members` is quick
to trace. Because a bad member id is invisible until someone installs the pack, install every pack
you publish against a sandbox before you tag it (see [test the pack](#test-the-pack)).

## Required, recommended, and a pack

Three separate fields spell _required_, and each keeps its own meaning. The glossary keeps them
apart at [required](/reference/glossary/#required); this section only notes how they meet a pack.

- A pack id may appear in [`meta.required`](/reference/glossary/#required) or
  [`meta.recommended`](/reference/glossary/#recommended). Listing `pack:demo` there makes the whole
  bundle the catalog's default selection: the members arrive pre-checked in the proposal picker,
  and `meta.required` cannot be unchecked while `meta.recommended` can. The example catalog does
  exactly this: `"recommended": ["pack:demo"]`.
- `level: "required"` is an **artifact** field, not a pack field. A pack is strict, so a `level` key
  on it is rejected. Set importance on the member artifacts, not on the pack.
- `secrets[].required` is an mcp concern and never appears on a pack.

## Targets and scopes: pack versus member

A pack declares its own `targets` and `scopes`, and so does every member. The schema requires both
on both, each non-empty. These are two independent declarations. When the installer expands a pack,
**each member is installed according to its own `targets` and `scopes`**, not the pack's: the pack's
declaration governs the pack entry, and the member's declaration governs how that member is written.

Nothing validates that a pack's targets and scopes match its members', so keep them consistent by
convention: a pack that advertises `["claude", "opencode"]` while a member supports only `claude`
will still install that member for `claude` alone. Declare on the pack the sets its members actually
share.

## What the installer sees

To the person installing, a pack is a **grouped selection**. `rigger ls` marks it as a pack
and counts its members rather than listing a nature:

```
Catalog (7 entries):
  [available]  example/skill:hello-rigger  skill      
  [available]  example/agent:demo          agent      
  [available]  example/guardrail:demo      guardrail  
  [available]  example/hook:demo           hook       
  [available]  example/context:demo        context    
  [available]  example/pack:demo           pack       (2 members)
  [available]  example/pack:full           pack       (5 members)
```

Selecting the pack installs its members, expanded and de-duplicated, in one transaction. The
[plan](/reference/glossary/#plan-dry-run) lists a change per resolved artifact: the pack id itself
never appears as an installed line, because a pack writes nothing:

```
--- Plan ---
Plan · 2 changes · scope: user (~/.claude)

+ example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

+ example/agent:demo   ~/.claude/agents/demo.md
  link  ~/.claude/agents/demo.md → store

Σ  2 links

--- Result ---
  [ok] Applied 2 file(s).
    + /tmp/tmp.rig8f2/.claude/skills/hello-rigger
    + /tmp/tmp.rig8f2/.claude/agents/demo.md
```

When your pack sits under `meta.required` or `meta.recommended`, its members also drive the proposal
picker a teammate meets the first time they wire up your catalog, pre-checked, and (for
recommended) theirs to uncheck. That picker mechanics is covered in
[create a catalog](/authoring/create-a-catalog/).

## Test the pack

Author a pack the way you author any entry: edit `catalog.json`, install it against a throwaway home
so nothing touches your real `~/.claude`, read the plan, then tag a release. Two paths install from
your working copy without a `catalog add` round-trip:

- Register the folder once under a local name and iterate: `rigger catalog add myteam
  "$(pwd)"`, then `rigger install myteam/pack:demo --yes`. The
  [sandbox setup](/authoring/create-a-catalog/#work-against-a-disposable-sandbox) shows the
  `RIGGER_HOME` throwaway home this relies on.
- Or install the local path directly, no registration: see
  [install from a URL or local path](/guides/ad-hoc-install/).

Always pass explicit ids and `--yes` in a non-interactive shell: `rigger install` with no id
in a script has no picker to fall back to and no plan to confirm. Resolve the pack once against the
sandbox, confirm the plan lists every member you expect and no `Unknown catalog entry` error, then
cut the version tag your team pins to.
