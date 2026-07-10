/**
 * Hook-merge logic for agent-rigger.
 *
 * Pure functions — no I/O, no filesystem access, no process.exit.
 * Consumers (adapters) call these to compute the next settings object to write;
 * the actual read/write is the adapter's concern.
 *
 * Target shape in settings.json (Claude Code native format):
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "Bash", "hooks": [ { "type": "command", "command": "...", "timeout": 5 } ] }
 *     ]
 *   }
 * }
 *
 * Invariants:
 * - All functions are idempotent.
 * - Input objects are never mutated (structural sharing via spread + map/filter).
 * - No while loops — only map/filter/reduce.
 * - exactOptionalPropertyTypes: timeout is omitted entirely when not provided.
 * - Preservation (R2): mergeHook/removeHook operate on the RAW event array and
 *   reassemble it keeping everything they do not recognize in place and in
 *   order — entries without `matcher` (native Claude Code format for Stop,
 *   SessionStart, PreCompact…), items that are not type:"command", unknown
 *   fields. Recognition is item-per-item (isMatcherEntry/isHookCommand), never
 *   a coercion of the whole array.
 * - Fail-closed (R2): a defined non-array value under hooks.<event> throws
 *   InvalidHooksEventError, and a defined non-plain-object value under `hooks`
 *   itself throws InvalidHooksRootError, instead of being silently replaced;
 *   callers abort before any write. hasHook stays lenient (audit path,
 *   read-only).
 * - Multi-entry recognition (R2): Claude Code accepts several entries with the
 *   SAME matcher under one event. hasHook and mergeHook's dedup inspect ALL
 *   recognized entries of the target matcher, never only the first one — a
 *   command already registered in a later entry must read as installed, and a
 *   repair install must never register it a second time (the guard would run
 *   twice on every tool use).
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

/**
 * The shape rigger recognizes and manages inside hooks.<event>.
 * `hooks` stays unknown[] on purpose: rigger only manages the command items it
 * recognizes inside it — foreign items are preserved untouched.
 */
interface MatcherEntry {
  matcher: string;
  hooks: unknown[];
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Human-readable description of a JSON value's shape, for error messages. */
function describeShape(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  const kind = typeof value;
  if (kind === 'object') {
    return 'an object';
  }
  return `a ${kind}`;
}

/**
 * Thrown by mergeHook/removeHook when the value under hooks.<event> is not an
 * array (e.g. a manual edit turned it into an object). Fail-closed: callers
 * abort before any write, so the settings file is never rewritten from a
 * malformed state. The CLI maps typed errors to exit codes — never
 * process.exit() here.
 */
export class InvalidHooksEventError extends Error {
  /** Hook event whose value has the wrong shape (e.g. "Stop"). */
  readonly event: string;
  /** JSON path of the malformed value inside the settings file (e.g. "hooks.Stop"). */
  readonly jsonPath: string;

  constructor(event: string, actual: unknown) {
    const jsonPath = `hooks.${event}`;
    super(
      `Invalid hooks shape at "${jsonPath}": expected an array of hook entries, `
        + `got ${describeShape(actual)}. Fix "${jsonPath}" in the settings file so it is a `
        + `JSON array, then retry. The file has not been modified.`,
    );
    this.name = 'InvalidHooksEventError';
    this.event = event;
    this.jsonPath = jsonPath;
  }
}

/**
 * Thrown by mergeHook/removeHook when the `hooks` root itself is defined but
 * not a plain object (e.g. a manual edit turned it into an array or a string).
 * Sibling of InvalidHooksEventError, one level up: silently coercing the root
 * to {} would make mergeHook REPLACE the user's whole hooks value and
 * removeHook DELETE it — a silent repair that destroys content (R2
 * fail-closed). Callers abort before any write; hasHook stays lenient (a
 * malformed root reads as "not installed" on the audit path).
 */
export class InvalidHooksRootError extends Error {
  /** JSON path of the malformed value inside the settings file (always "hooks"). */
  readonly jsonPath = 'hooks';

  constructor(actual: unknown) {
    super(
      `Invalid hooks shape at "hooks": expected an object mapping events to arrays, `
        + `got ${describeShape(actual)}. Fix "hooks" in the settings file so it is a `
        + `JSON object, then retry. The file has not been modified.`,
    );
    this.name = 'InvalidHooksRootError';
  }
}

// ---------------------------------------------------------------------------
// Public spec type
// ---------------------------------------------------------------------------

export interface HookSpec {
  event: string;
  matcher: string;
  command: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, no mutation)
// ---------------------------------------------------------------------------

/**
 * Build a HookCommand object. Sets timeout only when defined
 * (exactOptionalPropertyTypes: never assigns `timeout: undefined`).
 */
function buildHookCommand(command: string, timeout: number | undefined): HookCommand {
  if (timeout === undefined) {
    return { type: 'command', command };
  }
  return { type: 'command', command, timeout };
}

/**
 * Item-per-item predicate: is this event-array entry a matcher entry rigger
 * recognizes (matcher: string + hooks: array)? Entries that do not match are
 * NEVER dropped — they are preserved untouched by mergeHook/removeHook.
 */
function isMatcherEntry(item: unknown): item is MatcherEntry {
  return typeof item === 'object'
    && item !== null
    && typeof (item as Record<string, unknown>)['matcher'] === 'string'
    && Array.isArray((item as Record<string, unknown>)['hooks']);
}

/**
 * Item-per-item predicate: is this hooks[] item a command item rigger
 * recognizes (type: "command" + command: string)? Items that do not match are
 * NEVER dropped — they are preserved untouched by mergeHook/removeHook.
 */
function isHookCommand(item: unknown): item is HookCommand {
  return typeof item === 'object'
    && item !== null
    && (item as Record<string, unknown>)['type'] === 'command'
    && typeof (item as Record<string, unknown>)['command'] === 'string';
}

/**
 * Return the RAW entries array under hooks.<event>.
 *
 * - Absent key → empty array (nothing installed yet on this event).
 * - Defined non-array value → InvalidHooksEventError (fail-closed, R2):
 *   rewriting from a malformed shape would destroy user content, so callers
 *   must abort before any write.
 */
function rawEventEntries(hooksMap: Record<string, unknown>, event: string): unknown[] {
  const value = hooksMap[event];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new InvalidHooksEventError(event, value);
  }
  return value;
}

/** True when the value is a plain object usable as the hooks map. */
function isPlainHooksMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lenient read of the hooks map (audit path). Returns an empty object when
 * `hooks` is absent OR malformed — hasHook must never throw on a shape it
 * merely inspects.
 */
function readHooksMap(settings: Record<string, unknown>): Record<string, unknown> {
  const h = settings['hooks'];
  return isPlainHooksMap(h) ? h : {};
}

/**
 * Strict read of the hooks map (write path — mergeHook/removeHook).
 *
 * - Absent key → empty object (nothing installed yet).
 * - Defined non-plain-object value → InvalidHooksRootError (fail-closed, R2):
 *   rewriting from a malformed root would replace or delete user content, so
 *   callers must abort before any write.
 */
function requireHooksMap(settings: Record<string, unknown>): Record<string, unknown> {
  const h = settings['hooks'];
  if (h === undefined) {
    return {};
  }
  if (!isPlainHooksMap(h)) {
    throw new InvalidHooksRootError(h);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adds the hook under hooks.<event>.
 *
 * - If no recognized entry exists for `matcher`, appends one with a single command.
 * - If a recognized entry for `matcher` already exists, appends the command to
 *   its `hooks[]` array (deduped by command string among recognized commands).
 * - Idempotent: calling with the same (event, matcher, command) twice produces
 *   the same result as calling once.
 * - Preservation (R2): everything unrecognized in the raw event array survives
 *   in place and in order — entries without `matcher`, non-command items inside
 *   the targeted entry, unknown fields on the entry.
 * - Preserves all other keys in `settings` (including permissions.deny).
 * - Does not set `timeout` when absent in spec (exactOptionalPropertyTypes safe).
 *
 * @param settings - Current settings object (not mutated).
 * @param spec     - Hook to add.
 * @returns A new settings object with the hook registered.
 * @throws InvalidHooksRootError when `hooks` is defined but not a plain object.
 * @throws InvalidHooksEventError when hooks.<event> is defined but not an array.
 */
export function mergeHook(
  settings: Record<string, unknown>,
  spec: HookSpec,
): Record<string, unknown> {
  const { event, matcher, command } = spec;
  const hooksMap = requireHooksMap(settings);
  const rawEntries = rawEventEntries(hooksMap, event);

  const matcherIndex = rawEntries.findIndex(
    (item) => isMatcherEntry(item) && item.matcher === matcher,
  );

  // Dedup across ALL recognized entries of this matcher, not only the first:
  // Claude Code accepts several entries with the same matcher, and a manual
  // reorder may have moved the rigger command into a later one. Merging into
  // the first entry while the command lives in another would register it
  // twice — the guard would execute twice on every tool use (R2/R1).
  const alreadyPresent = rawEntries.some(
    (item) =>
      isMatcherEntry(item)
      && item.matcher === matcher
      && item.hooks.some((cmd) => isHookCommand(cmd) && cmd.command === command),
  );

  let nextEntries: unknown[];

  if (alreadyPresent) {
    nextEntries = [...rawEntries];
  } else if (matcherIndex === -1) {
    // No recognized entry for this matcher yet — append one, keep the rest.
    const newCmd = buildHookCommand(command, spec.timeout);
    nextEntries = [...rawEntries, { matcher, hooks: [newCmd] }];
  } else {
    // Entries exist but none carries the command — merge it into the FIRST
    // recognized entry's hooks[], preserving foreign items and unknown fields.
    const target = rawEntries[matcherIndex] as MatcherEntry;
    const newCmd = buildHookCommand(command, spec.timeout);
    nextEntries = rawEntries.map((item, idx) =>
      idx === matcherIndex ? { ...target, hooks: [...target.hooks, newCmd] } : item
    );
  }

  const nextHooksMap: Record<string, unknown> = { ...hooksMap, [event]: nextEntries };

  return { ...settings, hooks: nextHooksMap };
}

/**
 * Removes the specified command from hooks.<event>[matcher].
 *
 * Cleanup rules (applied in order):
 * 1. Remove the recognized command items matching `command` from the hooks[]
 *    of the recognized entries whose matcher === `matcher`.
 * 2. If such an entry's hooks[] becomes TRULY empty (foreign items count as
 *    content), remove that matcher entry.
 * 3. If the event's entries array is now empty, remove that event key.
 * 4. If the hooks map is now empty, remove the `hooks` key entirely.
 *
 * Preservation (R2): everything unrecognized survives in place and in order —
 * entries without `matcher`, non-command items (which also keep their entry
 * alive at step 2), unknown fields on the entry.
 *
 * No-op if the hook (event, matcher, command) is not present.
 * Input is never mutated.
 *
 * @param settings - Current settings object (not mutated).
 * @param spec     - Hook to remove (timeout is irrelevant for removal).
 * @returns A new settings object with the hook removed.
 * @throws InvalidHooksRootError when `hooks` is defined but not a plain object.
 * @throws InvalidHooksEventError when hooks.<event> is defined but not an array.
 */
export function removeHook(
  settings: Record<string, unknown>,
  spec: Omit<HookSpec, 'timeout'>,
): Record<string, unknown> {
  const { event, matcher, command } = spec;
  const hooksMap = requireHooksMap(settings);
  const rawEntries = rawEventEntries(hooksMap, event);

  // Steps 1 & 2 on the raw array: only recognized (matcher, command) pairs are
  // touched; everything else is passed through untouched.
  const nextEntries = rawEntries.flatMap((item): unknown[] => {
    if (!isMatcherEntry(item) || item.matcher !== matcher) {
      return [item];
    }
    const remaining = item.hooks.filter(
      (cmd) => !(isHookCommand(cmd) && cmd.command === command),
    );
    if (remaining.length === 0) {
      return [];
    }
    if (remaining.length === item.hooks.length) {
      return [item];
    }
    return [{ ...item, hooks: remaining }];
  });

  // Build next hooks map.
  const nextHooksMap: Record<string, unknown> = { ...hooksMap };

  if (nextEntries.length === 0) {
    // Step 3: remove the event key.
    delete nextHooksMap[event];
  } else {
    nextHooksMap[event] = nextEntries;
  }

  // Step 4: remove hooks key if the map is empty.
  const result: Record<string, unknown> = { ...settings };

  if (Object.keys(nextHooksMap).length === 0) {
    delete result['hooks'];
  } else {
    result['hooks'] = nextHooksMap;
  }

  return result;
}

/**
 * Returns true iff the command is registered under hooks.<event>[matcher].
 *
 * Matcher-strict and lenient (unchanged by R2): rigger always writes a matcher,
 * so only recognized matcher entries are inspected; a malformed root or event
 * value reads as "not installed" (audit is read-only — fail-closed belongs to
 * the write path).
 *
 * Inspects ALL recognized entries with the target matcher (Claude Code accepts
 * duplicates): a command living in a later same-matcher entry is installed —
 * reporting it "missing" would trigger a repair install that registers it a
 * second time (double execution on every tool use).
 *
 * @param settings - Current settings object.
 * @param spec     - Hook to check (timeout is irrelevant for lookup).
 */
export function hasHook(
  settings: Record<string, unknown>,
  spec: Omit<HookSpec, 'timeout'>,
): boolean {
  const { event, matcher, command } = spec;
  const hooksMap = readHooksMap(settings);
  const value = hooksMap[event];
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some(
    (item) =>
      isMatcherEntry(item)
      && item.matcher === matcher
      && item.hooks.some((cmd) => isHookCommand(cmd) && cmd.command === command),
  );
}
