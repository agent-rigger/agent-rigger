/**
 * Path-aware doctor scanners (R1, R3, R4, R7 — ADR-0025, design.md "Scanners à
 * connaissance de chemins → adapters/src/shared/doctor-scan.ts").
 *
 * Every scanner here produces the core's `Finding` type — no path literal ever
 * crosses back into `core/doctor` (ADR-0020). Depends on `core/linker` and
 * `core/paths` only; the dependency direction (adapters → core) is never
 * inverted, matching `shared/store-refs.ts`'s existing placement.
 *
 * ---------------------------------------------------------------------------
 * Scope decision — which natures R1's untracked scan actually covers
 * ---------------------------------------------------------------------------
 *
 * R1's rationale lists five ownership signatures, in decreasing strength: a
 * symlink resolving under the store, a byte-identical copy, a settings.json
 * hook pointing into the scriptStore, a marked CLAUDE.md block, a plugin
 * ledger key. Of these, only the first two are checkable WITHOUT an external
 * canonical value:
 *
 *   - skill / agent (claude, opencode) and opencode's plugin nature are
 *     SELF-REFERENTIAL: `Adapter.audit` classifies them purely by comparing
 *     the target against ITS OWN store (`resolvesToStore`/`contentMatchesStore`,
 *     core/linker) — no catalog content is needed to tell present from drift.
 *     These three natures × both scopes are what `createUntrackedScanner`
 *     below scans.
 *   - guardrail and mcp need the catalog's canonical rule/config set to tell
 *     "rigger-sourced" from "hand-authored" — this is exactly R1's own
 *     "host-diff" scenario (differential requires a reachable catalog),
 *     already modelled as `FindingUntrackedHostDiff` but deliberately NOT
 *     constructed by this catalog-free scanner (silently out of scope
 *     offline, per the scenario's own text).
 *   - claude's hook nature (settings.json → scriptStore) and context nature
 *     (CLAUDE.md block) both need catalog-sourced canonical data too
 *     (`hookSpec`, `agentsContent`) to run `Adapter.audit` correctly — a
 *     catalog-free audit would either reject with a config error or compare
 *     against an empty default, producing false verdicts. Left unconstructed
 *     here for the same reason, flagged rather than silently narrowed (same
 *     precedent as T2's manifest-audit leaving `applied-drift`
 *     unimplemented).
 *   - claude's plugin nature is ledger-keyed (`<name>@<marketplace>`); without
 *     a marketplace resolver there is no reliable way to match a raw ledger
 *     key against a tracked manifest entry (the manifest carries no
 *     `applied` payload for plugins), so a naive match risks a FALSE
 *     "untracked" on an already-tracked plugin — R1's own "zero faux positif
 *     prime" bias rules this out until marketplace resolution lands
 *     (R9/obs1, tracked separately).
 *
 * A dossier under a scanned root with NO store at the conventional path is
 * NEVER flagged (R1 "dossier homonyme" scenario) — the store's mere existence
 * is the necessary condition every signature above implies, so it is checked
 * FIRST as a plain existence gate. Once a store exists, the verdict
 * (present/drift) is deferred entirely to `Adapter.audit` — the SAME
 * present-strict gate `adapter.adopt`/`applyRepairs` (T4) will use — rather
 * than re-deriving present/drift from `resolvesToStore`/`contentMatchesStore`
 * a second time here. Two independent implementations of the same gate is
 * exactly the kind of drift ADR-0025's "present-strict jamais assoupli"
 * invariant warns against; calling the real gate once, always, is safer than
 * a second opinion that could quietly diverge from it.
 *
 * `.bak-*` / `.tmp-*` siblings are excluded from every enumeration below
 * (R1, R3, R4) — they are R7's territory, never a candidate for any other
 * class.
 */

import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { localId } from '@agent-rigger/catalog';
import type { CatalogCanon, CatalogEntry } from '@agent-rigger/catalog';
import {
  danglingTracked,
  danglingUntracked,
  hygieneBak,
  hygieneResidue,
  manifestAppliedDrift,
  phantomProbable,
  untrackedAdoptable,
  untrackedDrift,
  untrackedHostDiff,
} from '@agent-rigger/core';
import type { DoctorContext, DoctorScanner, Finding } from '@agent-rigger/core';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { readManifest } from '@agent-rigger/core/manifest';
import {
  resolveHome,
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveProjectTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  Assistant,
  ManifestEntry,
  Nature,
  OpencodePermission,
  Scope,
} from '@agent-rigger/core/types';

import { isStoreReferenced, storeReferenceCandidates } from './store-refs';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** `readdir` tolerant to an absent directory — never throws. */
async function safeReaddir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

/** `true` when `p` exists (file, dir, or symlink — lstat, never follows). */
async function pathExists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

/**
 * R1/R3/R4 exclusion filter: a `.bak-*` / `.tmp-*` sibling is NEVER a
 * candidate for untracked/dangling/phantom classification — R7 owns these
 * patterns exclusively.
 */
function isBakOrTmpSibling(name: string): boolean {
  return name.includes('.bak-') || name.includes('.tmp-');
}

/**
 * Absolute paths recorded by every entry currently in the manifest
 * (`files[]`), regardless of nature/scope/assistant. Used both to recognise
 * an already-tracked target (R1, R3) and, unioned into
 * `storeReferenceCandidates`, to widen the phantom refcount (R4).
 */
function allManifestFiles(
  manifest: Awaited<ReturnType<typeof readManifest>>,
): string[] {
  return manifest.artifacts.flatMap((entry) => entry.files);
}

// ---------------------------------------------------------------------------
// Family roots — where each self-referential (store-based) nature lives
// ---------------------------------------------------------------------------

/** One store-backed install family: a target directory paired with its store directory. */
interface LinkFamily {
  nature: Nature;
  assistant: Assistant;
  scope: Scope;
  targetDir: string;
  storeDir: string;
}

/**
 * The store-backed families for `assistant` (R1 untracked, R3 dangling both
 * reuse this — dangling needs no Adapter, so it calls the assistant-less
 * `allLinkFamilies` variant below instead of this one).
 *
 * - claude: skill (shared store), agent (own store) — both scopes.
 * - opencode: skill (SAME shared store as claude — ADR-0020 §3 "one store, N
 *   symlinks"), plugin (own store) — both scopes.
 * - copilot: no adapter yet (M4 reserved) — empty, never widens this file's
 *   surface until a real family is known.
 */
function linkFamiliesFor(assistant: Assistant, env: Env, cwd: string): LinkFamily[] {
  const skillsStore = resolveUserTargets(env).skillsDir;
  const agentsStore = path.join(path.dirname(skillsStore), 'agents');
  const pluginsStore = path.join(path.dirname(skillsStore), 'plugins');

  if (assistant === 'claude') {
    const claudeHome = path.dirname(resolveUserTargets(env).claudeSettings);
    return [
      {
        nature: 'skill',
        assistant,
        scope: 'user',
        targetDir: path.join(claudeHome, 'skills'),
        storeDir: skillsStore,
      },
      {
        nature: 'skill',
        assistant,
        scope: 'project',
        targetDir: path.join(cwd, '.claude', 'skills'),
        storeDir: skillsStore,
      },
      {
        nature: 'agent',
        assistant,
        scope: 'user',
        targetDir: path.join(claudeHome, 'agents'),
        storeDir: agentsStore,
      },
      {
        nature: 'agent',
        assistant,
        scope: 'project',
        targetDir: path.join(cwd, '.claude', 'agents'),
        storeDir: agentsStore,
      },
    ];
  }

  if (assistant === 'opencode') {
    const opencodeUser = resolveOpencodeUserTargets(env);
    const opencodeProject = resolveOpencodeProjectTargets(cwd);
    return [
      {
        nature: 'skill',
        assistant,
        scope: 'user',
        targetDir: opencodeUser.skillsDir,
        storeDir: skillsStore,
      },
      {
        nature: 'skill',
        assistant,
        scope: 'project',
        targetDir: opencodeProject.skillsDir,
        storeDir: skillsStore,
      },
      {
        nature: 'plugin',
        assistant,
        scope: 'user',
        targetDir: opencodeUser.pluginDir,
        storeDir: pluginsStore,
      },
      {
        nature: 'plugin',
        assistant,
        scope: 'project',
        targetDir: opencodeProject.pluginDir,
        storeDir: pluginsStore,
      },
    ];
  }

  // 'copilot' — reserved, no adapter, no on-disk convention (Hors périmètre).
  return [];
}

/** Every store-backed family, both assistants — used by the adapter-less R3/R4 scanners. */
function allLinkFamilies(env: Env, cwd: string): LinkFamily[] {
  return [...linkFamiliesFor('claude', env, cwd), ...linkFamiliesFor('opencode', env, cwd)];
}

/**
 * Derive the local id-name `Adapter.audit` must be handed so it reconstructs
 * EXACTLY `targetDir/entryName` as its target path:
 * - skill: the entry name IS the local name (a directory, used verbatim).
 * - agent / plugin: the entry name carries an extension (`<name>.md`,
 *   `<name>.<ext>`) that the adapter's own name-deriver re-appends — so the
 *   local name here is the extension-stripped basename.
 */
function localNameFor(nature: Nature, entryName: string): string {
  return nature === 'skill' ? entryName : path.parse(entryName).name;
}

// ---------------------------------------------------------------------------
// R1 — untracked scanner (per-assistant Scanner, design.md "Scanner[] composed")
// ---------------------------------------------------------------------------

/**
 * Build the R1 untracked scanner for one assistant's `Adapter`. The CLI (T5)
 * assembles one instance per configured assistant — adding Copilot (M4) is a
 * new call to this factory with its adapter, never a change to this file's
 * exported shape (design.md's "Scanner[] composed" point).
 *
 * For every store-backed family (see `linkFamiliesFor`): enumerate the target
 * directory, skip `.bak-*`/`.tmp-*` siblings and anything already tracked by
 * the manifest, skip anything with NO store at the conventional path (R1
 * "dossier homonyme" — never flagged, no signature), then classify the rest
 * via `adapter.audit` (present-strict, unchanged):
 * - `'present'` → `untrackedAdoptable` (R1 nominal + mass-amputation: every
 *   conforming untracked artifact routes here identically, no cause guessing).
 * - `'drift'`   → `untrackedDrift` (report-only, never adopted).
 * - `'missing'` (a dangling symlink with no manifest entry) or `'unknown'` →
 *   skipped: the former is R3's territory, not R1's.
 */
export function createUntrackedScanner(adapter: Adapter, assistant: Assistant): DoctorScanner {
  return async (ctx: DoctorContext): Promise<Finding[]> => {
    const cwd = process.cwd();
    const manifest = await readManifest(ctx.manifestPath);
    const tracked = new Set(allManifestFiles(manifest).map((f) => path.resolve(f)));

    const findings: Finding[] = [];

    for (const family of linkFamiliesFor(assistant, ctx.env, cwd)) {
      const names = await safeReaddir(family.targetDir);

      for (const name of names) {
        if (isBakOrTmpSibling(name)) continue;

        const candidatePath = path.join(family.targetDir, name);
        if (tracked.has(path.resolve(candidatePath))) continue;

        const storePath = path.join(family.storeDir, name);
        if (!(await pathExists(storePath))) continue; // homonym — no signature

        const localName = localNameFor(family.nature, name);
        const entry: AdapterEntry = {
          id: `${family.nature}:${localName}`,
          nature: family.nature,
          scope: family.scope,
        };
        const report = await adapter.audit(entry, family.scope, ctx.env);

        if (report.state === 'present') {
          findings.push(
            untrackedAdoptable({
              nature: family.nature,
              scope: family.scope,
              assistant: family.assistant,
              path: candidatePath,
              candidateId: entry.id,
              files: [candidatePath],
            }),
          );
        } else if (report.state === 'drift') {
          findings.push(
            untrackedDrift({
              nature: family.nature,
              scope: family.scope,
              assistant: family.assistant,
              path: candidatePath,
            }),
          );
        }
        // 'missing' (dangling, R3) or 'unknown' — not R1's concern, skip.
      }
    }

    return findings;
  };
}

// ---------------------------------------------------------------------------
// D4 — applied-drift scanner (per-assistant Scanner, offline — no catalog)
// ---------------------------------------------------------------------------

/**
 * Read the live mcp server map from the host config for `assistant` at `scope`.
 * Absent/invalid → {} (tolerant, never throws) — mirrors `claude/mcp.ts`'s
 * `readClaudeMcpServers` and `opencode/mcp.ts`'s `extractMcp`, re-derived here
 * rather than imported for the same reason `hooksStoreDir`/`store-refs.ts`
 * re-derive their adapters' private path helpers (this file's established
 * posture): the reader is the mcp handler's own private detail, and the scanner
 * needs only the map keyed by server name. Shared by the D4 applied-drift check
 * (`appliedEntryDrifts`) and the D2/D3 host-diff check (`hostDiffForMcp`).
 */
async function readLiveMcpServers(
  assistant: Assistant,
  scope: Scope,
  env: Env,
  cwd: string,
): Promise<Record<string, unknown>> {
  const [configPath, key] = assistant === 'claude'
    ? [
      scope === 'project'
        ? path.join(cwd, '.mcp.json')
        : path.join(resolveHome(env), '.claude.json'),
      'mcpServers',
    ]
    : [
      scope === 'project'
        ? resolveOpencodeProjectTargets(cwd).opencodeJson
        : resolveOpencodeUserTargets(env).opencodeJson,
      'mcp',
    ];

  const text = await Bun.file(configPath).text().catch(() => '');
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const servers = (parsed as Record<string, unknown>)[key];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

/**
 * `true` when a manifest entry's recorded `applied` payload (ADR-0016) no
 * longer matches the live host config — the D4 drift verdict per nature:
 *
 * - guardrail / opencode-permission / context / hook → delegated to
 *   `adapter.audit`, which reconstructs the canon from `entry.applied` (B-iii)
 *   and compares it to the live config. `drift`/`missing` → drift; `present` →
 *   silence. For guardrail this is a SUBSET check by design: a posted rule that
 *   vanished is `missing` (drift), a user rule ADDED on top keeps the applied
 *   set a subset (`present`, silence — the user's territory).
 * - claude-mcp / opencode-mcp → a DEEP-COMPARE local to the scanner
 *   (`isDeepStrictEqual`, the same gate `adoptMcp` uses): `applied.config` vs
 *   the live descriptor for the same server name. Absent or divergent → drift.
 *   `adapter.audit` is insufficient for mcp — it is key-only (present iff the
 *   server NAME is declared), blind to a content drift under the same name.
 */
async function appliedEntryDrifts(
  adapter: Adapter,
  entry: ManifestEntry,
  applied: NonNullable<ManifestEntry['applied']>,
  env: Env,
  cwd: string,
): Promise<boolean> {
  if (applied.kind === 'claude-mcp' || applied.kind === 'opencode-mcp') {
    const assistant: Assistant = applied.kind === 'claude-mcp' ? 'claude' : 'opencode';
    const servers = await readLiveMcpServers(assistant, entry.scope, env, cwd);
    const live = servers[applied.server];
    return live === undefined || !isDeepStrictEqual(live, applied.config);
  }

  const adapterEntry: AdapterEntry = {
    id: entry.id,
    nature: entry.nature,
    scope: entry.scope,
    applied,
  };
  const report = await adapter.audit(adapterEntry, entry.scope, env);
  return report.state === 'drift' || report.state === 'missing';
}

/**
 * Build the D4 applied-drift scanner for one assistant's `Adapter`. The CLI
 * (T4) assembles one instance per configured assistant, grouped right after the
 * R2 manifest-audit (same `manifest` class). Purely OFFLINE: the reference is
 * the manifest's own `applied` payload, never a fetched catalog — so this
 * scanner runs UNCONDITIONALLY, with or without `--remote` (D4 vs the catalog
 * differential's `--remote` gate).
 *
 * For every manifest entry of THIS assistant (`entry.assistant ?? 'claude'`)
 * carrying an `applied` payload:
 * - `link` (skill/agent/plugin symlink installs) is EXCLUDED — its integrity is
 *   already covered by R2's `files[]` check and R1's untracked scan; there is
 *   no live host-config referent to confront here.
 * - every other kind → `manifestAppliedDrift` (report-only, no `repair`) iff
 *   `appliedEntryDrifts` — the report explains the two ways out (reinstall to
 *   re-post, or `remove` to stop tracking).
 *
 * Legacy entries with no `applied` payload (installed before B-iii) are
 * silently skipped: there is nothing to confront.
 */
export function createAppliedDriftScanner(
  adapter: Adapter,
  assistant: Assistant,
): DoctorScanner {
  return async (ctx: DoctorContext): Promise<Finding[]> => {
    const cwd = process.cwd();
    const manifest = await readManifest(ctx.manifestPath);

    const findings: Finding[] = [];

    for (const entry of manifest.artifacts) {
      if ((entry.assistant ?? 'claude') !== assistant) continue;
      const applied = entry.applied;
      if (applied === undefined) continue;
      if (applied.kind === 'link') continue; // R2 files[] / R1 untracked own this

      if (await appliedEntryDrifts(adapter, entry, applied, ctx.env, cwd)) {
        findings.push(
          manifestAppliedDrift({ entryId: entry.id, nature: entry.nature, scope: entry.scope }),
        );
      }
    }

    return findings;
  };
}

// ---------------------------------------------------------------------------
// D2 + D3 — host-diff scanner (per-assistant Scanner, --remote — needs canons)
// ---------------------------------------------------------------------------

/**
 * `true` when a manifest entry of this assistant already claims the canon
 * element identified by `localKey` (its un-qualified `nature:name`) at `scope`.
 * The catalog id and the manifest id may carry different catalog prefixes (or
 * none), so both are reduced through `localId` before comparison — the same
 * qualify/de-qualify seam the resolver uses. A tracked element is never a
 * host-diff: its integrity is R2/D4 territory, not this scanner's (D2/D3
 * "élément canon déjà tracé au manifest → pas un host-diff").
 */
function manifestTracksElement(
  manifest: Awaited<ReturnType<typeof readManifest>>,
  nature: Nature,
  scope: Scope,
  assistant: Assistant,
  localKey: string,
): boolean {
  return manifest.artifacts.some(
    (entry) =>
      entry.nature === nature
      && entry.scope === scope
      && (entry.assistant ?? 'claude') === assistant
      && localId(entry.id) === localKey,
  );
}

/**
 * D2 verdict for the CONTEXT nature: the host coincides EXACTLY with the canon
 * iff `adapter.audit` — fed a synthetic `applied` payload carrying the canon
 * block — reports `present`. `auditContext` compares the whole AGENTS.md file
 * BYTE-EXACT (`currentAgents === agentsContent`, claude/context.ts:156), so its
 * `present` verdict already means byte-identical coincidence — routing context
 * through the real gate is safe (the posture `createUntrackedScanner` takes).
 *
 * NOT reused for guardrail: `auditGuardrail`'s `present` is a SUBSET verdict
 * (canon ⊆ host — `computeMissingDeny`, core/deny.ts:27), which a host that is a
 * SUPERSET of the canon (extra user-authored rules) also satisfies. That would
 * mislabel user rules as a byte-identical host-diff, violating D2's "coïncide
 * exactement" bar and its zero-false-positive rationale. Guardrail compares the
 * canon and host deny/allow sets EXACTLY instead (`guardrailHostCoincides`).
 *
 * Any other verdict is a divergence, and a divergence for context is SILENCE
 * (D2 rationale — zero false positive: a modified block is user territory).
 */
async function hostCoincidesWithCanon(
  adapter: Adapter,
  synthetic: AdapterEntry,
  scope: Scope,
  env: Env,
): Promise<boolean> {
  const report = await adapter.audit(synthetic, scope, env);
  return report.state === 'present';
}

/** `true` iff `a` and `b` hold the same rules as SETS (order- and duplicate-insensitive). */
function sameRuleSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every((rule) => setB.has(rule));
}

/**
 * Read the live claude `permissions.deny` / `permissions.allow` for `scope`,
 * tolerant to an absent/invalid settings.json ({deny: [], allow: []}). Mirrors
 * `claude/guardrails.ts`'s private `extractDeny`/`extractAllow`, re-derived here
 * for the same reason `readLiveMcpServers` re-derives the mcp reader — the
 * scanner needs the raw host rule sets to compare them EXACTLY against the
 * canon, which `adapter.audit` (a one-directional subset check) cannot express.
 */
async function readHostGuardrailRules(
  scope: Scope,
  env: Env,
  cwd: string,
): Promise<{ deny: string[]; allow: string[] }> {
  const settingsPath = scope === 'project'
    ? resolveProjectTargets(cwd).claudeSettings
    : resolveUserTargets(env).claudeSettings;
  const text = await Bun.file(settingsPath).text().catch(() => '');
  if (text === '') return { deny: [], allow: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { deny: [], allow: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { deny: [], allow: [] };
  }
  const perms = (parsed as Record<string, unknown>)['permissions'];
  if (perms === null || typeof perms !== 'object' || Array.isArray(perms)) {
    return { deny: [], allow: [] };
  }
  const pick = (key: string): string[] => {
    const value = (perms as Record<string, unknown>)[key];
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  };
  return { deny: pick('deny'), allow: pick('allow') };
}

/**
 * D2 verdict for the GUARDRAIL nature: the host coincides EXACTLY with the canon
 * iff the live claude deny AND allow rule sets equal the canon's deny/allow sets
 * exactly. Unlike `auditGuardrail`'s subset `present`, this rejects a host that
 * is a SUPERSET of the canon (extra user rules) — a content deviation is user
 * territory, never a byte-identical host-diff (D2 "coïncide exactement", zero
 * false positive).
 */
async function guardrailHostCoincides(
  rules: { deny: string[]; allow: string[] },
  scope: Scope,
  env: Env,
  cwd: string,
): Promise<boolean> {
  const host = await readHostGuardrailRules(scope, env, cwd);
  return sameRuleSet(host.deny, rules.deny) && sameRuleSet(host.allow, rules.allow);
}

/**
 * Read the live opencode `permission` object for `scope`, tolerant to an
 * absent/invalid opencode.json ({}). Mirrors the opencode guardrail audit's own
 * reader (`opencode-json-io.ts`'s `readOpencodeJson` + `guardrails.ts`'s private
 * `extractPermission`), re-derived here for the same reason `readLiveMcpServers`
 * and `readHostGuardrailRules` re-derive their adapters' private readers (this
 * file's established posture — adapters → core only, never a cross-adapter
 * import). opencode.json is JSONC (comments + trailing commas), so it is parsed
 * jsonc-tolerantly exactly like the real audit, not with strict JSON.parse: a
 * legitimately commented config must not read as `{}` and mask a real
 * coincidence.
 */
async function readHostOpencodePermission(
  scope: Scope,
  env: Env,
  cwd: string,
): Promise<OpencodePermission> {
  const configPath = scope === 'project'
    ? resolveOpencodeProjectTargets(cwd).opencodeJson
    : resolveOpencodeUserTargets(env).opencodeJson;
  const text = await Bun.file(configPath).text().catch(() => '');
  if (text.trim() === '') return {};
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const perm = (parsed as Record<string, unknown>)['permission'];
  if (perm === null || typeof perm !== 'object' || Array.isArray(perm)) {
    return {};
  }
  return perm as OpencodePermission;
}

/**
 * D2 verdict for the opencode GUARDRAIL nature: the host coincides EXACTLY with
 * the canon iff the live opencode `permission` object DEEP-EQUALS the canon
 * descriptor (`isDeepStrictEqual`, the same exact-content gate mcp uses). A host
 * that is a SUPERSET (extra user leaves) or a SUBSET (a canon leaf missing) is
 * not deep-equal → silence — a content deviation is user territory, never a
 * byte-identical host-diff (D2 "coïncide exactement", zero false positive). This
 * is the opencode analogue of `guardrailHostCoincides`'s exact-set posture for
 * claude, honouring D2's "les deux assistants" requirement.
 */
async function opencodePermissionHostCoincides(
  permission: OpencodePermission,
  scope: Scope,
  env: Env,
  cwd: string,
): Promise<boolean> {
  const host = await readHostOpencodePermission(scope, env, cwd);
  return isDeepStrictEqual(host, permission);
}

/**
 * D2/D3 verdict for one canon entry at one scope, or `undefined` for silence.
 *
 * - guardrail / context: coincidence (host byte-identical to canon) →
 *   `untrackedHostDiff` (D2); divergence → silence. The guardrail canon is
 *   assistant-specific: claude reads deny/allow (`canon.guardrails`, exact set
 *   equality), opencode reads the native `permission` descriptor
 *   (`canon.guardrailPermissions`, exact deep-equal). A guardrail whose canon is
 *   absent for THIS assistant (e.g. a claude-only entry seen by the opencode
 *   scanner, or vice versa) → skipped, not a finding.
 * - mcp: a live server under the SAME name whose descriptor deep-equals the
 *   canon `config` → the D2 coincidence finding; a same-name server that
 *   DIVERGES → the D3 finding, whose detail states "diverges from the canon,
 *   never adopted" and names the two manual ways out (reinstall with consent, or
 *   remove by hand); no homonym → silence (user content, D3). The comparison is
 *   against the inline catalog `config` verbatim — a catalog that renders
 *   secrets (${VAR}) would compare its unrendered form, a documented
 *   approximation acceptable here because a real secret drift still surfaces as
 *   a divergence, never a false coincidence.
 */
async function hostDiffForEntry(
  adapter: Adapter,
  assistant: Assistant,
  canon: CatalogCanon,
  entry: Extract<CatalogEntry, { kind: 'artifact' }>,
  scope: Scope,
  localKey: string,
  env: Env,
  cwd: string,
): Promise<Finding | undefined> {
  if (entry.nature === 'guardrail') {
    if (assistant === 'opencode') {
      // The opencode guardrail canon is a native `permission` descriptor, not
      // deny/allow — confront the live opencode.json permission by exact deep-equal.
      const permission = canon.guardrailPermissions.get(entry.id);
      if (permission === undefined) return undefined; // claude-only guardrail, no opencode canon
      if (!(await opencodePermissionHostCoincides(permission, scope, env, cwd))) return undefined;
      return untrackedHostDiff({
        nature: 'guardrail',
        scope,
        assistant,
        detail: `guardrail "${localKey}" from catalog "${canon.name}" is present at the host `
          + 'byte-identical to the canon but tracked by no manifest entry — adopt it '
          + '(reinstall to record it) or remove it by hand.',
      });
    }
    const rules = canon.guardrails.get(entry.id);
    if (rules === undefined) return undefined; // opencode-only guardrail, no claude canon
    if (!(await guardrailHostCoincides(rules, scope, env, cwd))) return undefined;
    return untrackedHostDiff({
      nature: 'guardrail',
      scope,
      assistant,
      detail: `guardrail "${localKey}" from catalog "${canon.name}" is present at the host `
        + 'byte-identical to the canon but tracked by no manifest entry — adopt it '
        + '(reinstall to record it) or remove it by hand.',
    });
  }

  if (entry.nature === 'context') {
    const block = canon.contexts.get(entry.id);
    if (block === undefined) return undefined;
    const synthetic: AdapterEntry = {
      id: entry.id,
      nature: 'context',
      scope,
      applied: { kind: 'context', block },
    };
    if (!(await hostCoincidesWithCanon(adapter, synthetic, scope, env))) return undefined;
    return untrackedHostDiff({
      nature: 'context',
      scope,
      assistant,
      detail: `context "${localKey}" from catalog "${canon.name}" is present at the host `
        + 'byte-identical to the canon but tracked by no manifest entry — adopt it '
        + '(reinstall to record it) or remove it by hand.',
    });
  }

  if (entry.nature === 'mcp') {
    if (entry.config === undefined) return undefined;
    const server = localKey.replace(/^mcp:/, '');
    const servers = await readLiveMcpServers(assistant, scope, env, cwd);
    if (!Object.prototype.hasOwnProperty.call(servers, server)) return undefined; // no homonym
    if (isDeepStrictEqual(servers[server], entry.config)) {
      return untrackedHostDiff({
        nature: 'mcp',
        scope,
        assistant,
        detail: `mcp server "${server}" from catalog "${canon.name}" is present at the host `
          + 'byte-identical to the canon but tracked by no manifest entry — adopt it '
          + '(reinstall to record it) or remove it by hand.',
      });
    }
    return untrackedHostDiff({
      nature: 'mcp',
      scope,
      assistant,
      detail: `mcp server "${server}" from catalog "${canon.name}" is present at the host `
        + 'under the same name but diverges from the canon, and no manifest entry tracks it — '
        + 'it was never adopted by rigger: reinstall it with consent to adopt the canon config, '
        + 'or remove it by hand.',
    });
  }

  // Every other nature leaves a disk signature — R1 untracked / R2 owns it.
  return undefined;
}

/**
 * Build the D2/D3 host-diff scanner for one assistant's `Adapter`, closed over
 * the fetched catalog canons (`--remote` only — without the flag the CLI never
 * constructs this scanner, so these signature-less natures stay silently out of
 * scope, exactly as offline v1). Per canon entry that TARGETS this assistant and
 * is NOT already tracked by the manifest, at each supported scope, delegate the
 * verdict to `hostDiffForEntry`.
 *
 * Report-only by construction: `untrackedHostDiff` carries no `repair` field, so
 * the consent-driver and the `--fix` exit contract are untouched (design §5).
 */
export function createHostDiffScanner(
  adapter: Adapter,
  assistant: Assistant,
  canons: CatalogCanon[],
): DoctorScanner {
  return async (ctx: DoctorContext): Promise<Finding[]> => {
    const cwd = process.cwd();
    const manifest = await readManifest(ctx.manifestPath);

    const findings: Finding[] = [];

    for (const canon of canons) {
      for (const entry of canon.entries) {
        if (entry.kind !== 'artifact') continue;
        if (!entry.targets.includes(assistant)) continue;

        const localKey = localId(entry.id);
        for (const scope of entry.scopes) {
          if (manifestTracksElement(manifest, entry.nature, scope, assistant, localKey)) continue;
          const finding = await hostDiffForEntry(
            adapter,
            assistant,
            canon,
            entry,
            scope,
            localKey,
            ctx.env,
            cwd,
          );
          if (finding !== undefined) findings.push(finding);
        }
      }
    }

    return findings;
  };
}

// ---------------------------------------------------------------------------
// R3 — dangling scanner (assistant-agnostic — no Adapter needed)
// ---------------------------------------------------------------------------

/**
 * Build the R3 dangling-symlink scanner. Needs no `Adapter`: a dead symlink
 * is dead regardless of nature-specific canonical content, so this single
 * scanner walks EVERY store-backed family root (both assistants).
 *
 * `readlink` only ever runs under a rigger root (the family target
 * directories enumerated by `allLinkFamilies`) — anything outside is never
 * even listed, let alone touched (R3 "pendant hors racines rigger →
 * intouchable", satisfied by construction, not by a check).
 *
 * For each symlink whose resolved target is gone:
 * - tracked by a manifest entry's `files[]` → `danglingTracked` (report +
 *   "reinstall" suggestion; `--fix` never re-links silently).
 * - untracked → `danglingUntracked` (removable, item-confirm).
 */
export function createDanglingScanner(): DoctorScanner {
  return async (ctx: DoctorContext): Promise<Finding[]> => {
    const cwd = process.cwd();
    const manifest = await readManifest(ctx.manifestPath);
    const trackedEntryIdByPath = new Map<string, string>();
    for (const entry of manifest.artifacts) {
      for (const filePath of entry.files) {
        trackedEntryIdByPath.set(path.resolve(filePath), entry.id);
      }
    }

    const findings: Finding[] = [];

    for (const family of allLinkFamilies(ctx.env, cwd)) {
      const names = await safeReaddir(family.targetDir);

      for (const name of names) {
        if (isBakOrTmpSibling(name)) continue;

        const candidatePath = path.join(family.targetDir, name);
        const lst = await lstat(candidatePath).catch(() => null);
        if (lst === null || !lst.isSymbolicLink()) continue;

        // stat() follows the link: null → the link value resolves to nothing.
        const resolved = await stat(candidatePath).catch(() => null);
        if (resolved !== null) continue; // alive — not dangling

        const readlinkValue = await readlink(candidatePath).catch(() => '');
        const entryId = trackedEntryIdByPath.get(path.resolve(candidatePath));

        if (entryId === undefined) {
          findings.push(danglingUntracked({ path: candidatePath, readlink: readlinkValue }));
        } else {
          findings.push(danglingTracked({ entryId, readlink: readlinkValue }));
        }
      }
    }

    return findings;
  };
}

// ---------------------------------------------------------------------------
// R4 — phantom scanner (assistant-agnostic — no Adapter needed)
// ---------------------------------------------------------------------------

/**
 * Path of the shared hook scriptStore: `<dirname(stateJson)>/hooks`.
 * Mirrors `cli/src/adapter-builder.ts`'s `hookScriptStorePath` verbatim — this
 * package cannot import from `cli` (wrong dependency direction), so the
 * deterministic-from-env convention is re-derived here, same posture as
 * `shared/store-refs.ts` re-deriving each adapter's private path helpers.
 */
function hooksStoreDir(env: Env): string {
  return path.join(path.dirname(resolveUserTargets(env).stateJson), 'hooks');
}

/**
 * `true` when the scriptStore is referenced by a LIVE settings.json hook
 * command (either reachable claude scope) — the scriptStore itself is never
 * symlinked (it is a shared directory of script files, referenced by a path
 * SUBSTRING inside a hook `command`, not by a target resolving to it), so
 * `storeReferenceCandidates`/`isStoreReferenced` (symlink-based) do not apply
 * to it; this is the scriptStore-specific referent check R4's crash scenario
 * names explicitly ("aucune commande de settings.json ... ne pointant dedans").
 */
async function scriptStoreReferencedByHostConfig(
  hooksDir: string,
  env: Env,
  cwd: string,
): Promise<boolean> {
  const settingsPaths = [
    resolveUserTargets(env).claudeSettings,
    resolveProjectTargets(cwd).claudeSettings,
  ];
  for (const settingsPath of settingsPaths) {
    const text = await Bun.file(settingsPath).text().catch(() => '');
    if (text.includes(hooksDir)) return true;
  }
  return false;
}

/**
 * R4's referent (1): `true` when a manifest entry of `nature` still DERIVES
 * this exact store — i.e. one of its recorded `files[]` shares `name`'s
 * basename — independent of whether that file still exists as a live
 * symlink. `storeReferenceCandidates`/`isStoreReferenced` (referent 2) only
 * prove liveness; a symlink removed out of band (the target deleted, the
 * store left untouched) makes referent (2) go false while the manifest entry
 * — and therefore referent (1) — is still there (R2 separately reports the
 * vanished symlink as a `missing-file`). `storeReferenceCandidates` itself
 * confirms this basename correlation is the right one: it derives every
 * static candidate path from `path.basename(store)` (ADR-0020 §3 "one store,
 * N symlinks" — store and every target share the same basename).
 */
function isDesignatedByManifestEntry(
  manifest: Awaited<ReturnType<typeof readManifest>>,
  nature: Nature,
  name: string,
): boolean {
  return manifest.artifacts.some(
    (entry) => entry.nature === nature && entry.files.some((f) => path.basename(f) === name),
  );
}

/**
 * Build the R4 phantom-store scanner. Needs no `Adapter`: refcounting is pure
 * filesystem truth (`storeReferenceCandidates`/`isStoreReferenced`, already
 * assistant-agnostic in `shared/store-refs.ts`).
 *
 * Named stores (skill/agent/plugin, one entry per basename under the skills/
 * agents/plugins store roots): R4 names TWO referents, checked independently —
 * (1) a manifest entry whose store derives to this exact path
 * (`isDesignatedByManifestEntry`, keyed on the store's own nature), and (2) a
 * live symlink resolving to it, via `storeReferenceCandidates` ELARGI with
 * `allManifestFiles` (R4 "storeReferenceCandidates élargi des files[] de
 * TOUTES les entrées manifest" — every entry, not just those surviving some
 * pending removal, since no removal is in progress here). A store with
 * EITHER referent is NOT a phantom — tracked-and-live is nothing wrong,
 * tracked-but-dangling is R2's `missing-file` territory, untracked-but-live
 * falls to R1's untracked/adoptable route; this scanner simply never reports
 * it, no cross-scanner coordination needed.
 *
 * The scriptStore (hooks) is a single SHARED directory, not a per-name family
 * — its own referent check (`scriptStoreReferencedByHostConfig`) plus "is
 * there still a `hook`-nature manifest entry" (the SAME referent-(1)
 * shape as the named stores above) together answer R4's crash scenario
 * literally.
 *
 * Every verdict is `phantomProbable` — "probable", never "certain" (R4 §—
 * a project-scope referent from another cwd is invisible by construction).
 */
export function createPhantomScanner(): DoctorScanner {
  return async (ctx: DoctorContext): Promise<Finding[]> => {
    const cwd = process.cwd();
    const manifest = await readManifest(ctx.manifestPath);
    const manifestFiles = allManifestFiles(manifest);

    const findings: Finding[] = [];

    const skillsStore = resolveUserTargets(ctx.env).skillsDir;
    const namedStoreRoots: { nature: Nature; root: string }[] = [
      { nature: 'skill', root: skillsStore },
      { nature: 'agent', root: path.join(path.dirname(skillsStore), 'agents') },
      { nature: 'plugin', root: path.join(path.dirname(skillsStore), 'plugins') },
    ];

    for (const { nature, root } of namedStoreRoots) {
      const names = await safeReaddir(root);
      for (const name of names) {
        if (isBakOrTmpSibling(name)) continue;
        if (isDesignatedByManifestEntry(manifest, nature, name)) continue; // referent (1)

        const storePath = path.join(root, name);
        const candidates = storeReferenceCandidates(storePath, ctx.env, cwd, manifestFiles);
        if (await isStoreReferenced(storePath, candidates)) continue; // referent (2)

        findings.push(phantomProbable({ store: storePath, candidates }));
      }
    }

    const hooksDir = hooksStoreDir(ctx.env);
    if (await pathExists(hooksDir)) {
      const hasHookEntry = manifest.artifacts.some((entry) => entry.nature === 'hook');
      const referencedByHost = hasHookEntry
        || (await scriptStoreReferencedByHostConfig(hooksDir, ctx.env, cwd));
      if (!referencedByHost) {
        findings.push(phantomProbable({ store: hooksDir, candidates: [] }));
      }
    }

    return findings;
  };
}

// ---------------------------------------------------------------------------
// R7 — hygiene scanner (assistant-agnostic — no Adapter needed)
// ---------------------------------------------------------------------------

/** Matches the exact `.tmp-<8hex>` suffix `fs-json.ts`/`backup.ts` produce — never a looser glob. */
const TMP_SUFFIX_RE = /\.tmp-[0-9a-f]{8}$/;

/** Matches the exact `.bak-<ISO>-<8hex>` suffix `backup.ts`'s `backupDest` produces. */
const BAK_SUFFIX_RE = /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/;

/** Prefix `cli/src/remote.ts`'s `defaultTmpFactory` gives every catalog checkout dir. */
const CATALOG_CHECKOUT_PREFIX = 'agent-rigger-catalog-';

/** Age past which an orphaned `.tmp-*`/checkout residue is proposed for deletion (safe, R7). */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How many of the most recent `.bak-*` siblings (per original basename) are
 * ALWAYS kept regardless of age — R7's "âge + keep-last-N" retention policy.
 * Not pinned by requirements.md to a specific number; 3 is this scanner's
 * documented default, overridable via `HygieneScannerOptions.keepLastN`.
 */
const DEFAULT_KEEP_LAST_N = 3;

export interface HygieneScannerOptions {
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  /** Age threshold in ms past which residue/aged .bak become proposable. Default 24h. */
  maxAgeMs?: number;
  /** Most-recent `.bak-*` per basename group always kept, regardless of age. Default 3. */
  keepLastN?: number;
}

/**
 * Every directory where a rigger-owned `.tmp-*`/`.bak-*` sibling can appear:
 * next to state.json, next to each scope's settings.json/opencode.json (the
 * exact atomic-write siblings `fs-json.ts` produces), and inside each
 * store root itself (`backupDir`'s sibling convention — `<store>.bak-...`
 * lives ALONGSIDE `<store>`, i.e. inside the store root, not its parent).
 */
function hygieneScanDirs(env: Env, cwd: string): string[] {
  const skillsStore = resolveUserTargets(env).skillsDir;
  return [
    ...new Set([
      path.dirname(resolveUserTargets(env).stateJson),
      path.dirname(resolveUserTargets(env).claudeSettings),
      path.dirname(resolveProjectTargets(cwd).claudeSettings),
      path.dirname(resolveOpencodeUserTargets(env).opencodeJson),
      path.dirname(resolveOpencodeProjectTargets(cwd).opencodeJson),
      skillsStore,
      path.join(path.dirname(skillsStore), 'agents'),
      path.join(path.dirname(skillsStore), 'plugins'),
      hooksStoreDir(env),
    ]),
  ];
}

/**
 * Build the R7 hygiene scanner: `.tmp-*` staging residue and aged catalog
 * checkouts are always-safe once past `maxAgeMs` (`delete-residue`, `--yes`
 * suffices); `.bak-*` past BOTH the age threshold AND the keep-last-N
 * retention is `delete-bak` (item-confirm, never `--yes` alone — R7's
 * rationale: a `.bak` is ADR-0016's sole reversibility net). A RECENT `.bak`
 * is never even surfaced (R7 "intouchable par défaut"), and neither is one of
 * the `keepLastN` most recent per basename group, regardless of age.
 *
 * Needs no run-lock check of its own: `diagnose()`'s ordering contract
 * (lock scanner first, abstain on a live run) already guarantees this scanner
 * never runs while a run is in flight (ADR-0025 §7 "scan pendant un run
 * vivant").
 */
export function createHygieneScanner(options: HygieneScannerOptions = {}): DoctorScanner {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const keepLastN = options.keepLastN ?? DEFAULT_KEEP_LAST_N;

  return async (ctx: DoctorContext): Promise<Finding[]> => {
    const cwd = process.cwd();
    const findings: Finding[] = [];
    const bakGroups = new Map<string, { path: string; mtimeMs: number }[]>();

    for (const dir of hygieneScanDirs(ctx.env, cwd)) {
      const names = await safeReaddir(dir);
      for (const name of names) {
        const full = path.join(dir, name);

        if (TMP_SUFFIX_RE.test(name)) {
          const st = await lstat(full).catch(() => null);
          if (st === null) continue;
          const ageMs = now() - st.mtimeMs;
          if (ageMs > maxAgeMs) {
            findings.push(hygieneResidue({ path: full, ageMs }));
          }
          continue;
        }

        if (BAK_SUFFIX_RE.test(name)) {
          const st = await lstat(full).catch(() => null);
          if (st === null) continue;
          const groupKey = path.join(dir, name.slice(0, name.indexOf('.bak-')));
          const group = bakGroups.get(groupKey) ?? [];
          group.push({ path: full, mtimeMs: st.mtimeMs });
          bakGroups.set(groupKey, group);
        }
      }
    }

    // Aged temporary catalog checkouts under the tmpdir (R7).
    const tmpRoot = tmpdir();
    for (const name of await safeReaddir(tmpRoot)) {
      if (!name.startsWith(CATALOG_CHECKOUT_PREFIX)) continue;
      const full = path.join(tmpRoot, name);
      const st = await lstat(full).catch(() => null);
      if (st === null) continue;
      const ageMs = now() - st.mtimeMs;
      if (ageMs > maxAgeMs) {
        findings.push(hygieneResidue({ path: full, ageMs }));
      }
    }

    // .bak retention: age + keep-last-N — the newest `keepLastN` per group are
    // NEVER proposed, regardless of age; the rest need BOTH conditions.
    for (const group of bakGroups.values()) {
      const sorted = [...group].sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const entry of sorted.slice(keepLastN)) {
        const ageMs = now() - entry.mtimeMs;
        if (ageMs > maxAgeMs) {
          findings.push(hygieneBak({ path: entry.path, ageMs }));
        }
      }
    }

    return findings;
  };
}
