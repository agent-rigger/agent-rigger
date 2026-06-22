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
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface MatcherEntry {
  matcher: string;
  hooks: HookCommand[];
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
 * Coerce an unknown value to a MatcherEntry array, dropping invalid entries.
 * Defensive: if the existing settings.json has an unexpected shape, we degrade
 * gracefully rather than crashing.
 */
function toMatcherEntries(value: unknown): MatcherEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is MatcherEntry =>
      typeof item === 'object'
      && item !== null
      && typeof (item as Record<string, unknown>)['matcher'] === 'string'
      && Array.isArray((item as Record<string, unknown>)['hooks']),
  );
}

/**
 * Coerce an unknown value to a HookCommand array, dropping invalid entries.
 */
function toHookCommands(value: unknown): HookCommand[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is HookCommand =>
      typeof item === 'object'
      && item !== null
      && (item as Record<string, unknown>)['type'] === 'command'
      && typeof (item as Record<string, unknown>)['command'] === 'string',
  );
}

/**
 * Read the hooks map from settings. Returns an empty object if absent/invalid.
 */
function getHooksMap(settings: Record<string, unknown>): Record<string, unknown> {
  const h = settings['hooks'];
  if (typeof h === 'object' && h !== null && !Array.isArray(h)) {
    return h as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adds the hook under hooks.<event>.
 *
 * - If no entry exists for `matcher`, creates one with a single command.
 * - If an entry for `matcher` already exists, appends the command to its
 *   `hooks[]` array (deduped by command string).
 * - Idempotent: calling with the same (event, matcher, command) twice produces
 *   the same result as calling once.
 * - Preserves all other keys in `settings` (including permissions.deny).
 * - Does not set `timeout` when absent in spec (exactOptionalPropertyTypes safe).
 *
 * @param settings - Current settings object (not mutated).
 * @param spec     - Hook to add.
 * @returns A new settings object with the hook registered.
 */
export function mergeHook(
  settings: Record<string, unknown>,
  spec: HookSpec,
): Record<string, unknown> {
  const { event, matcher, command } = spec;
  const hooksMap = getHooksMap(settings);
  const existingEntries = toMatcherEntries(hooksMap[event]);

  const matcherIndex = existingEntries.findIndex((e) => e.matcher === matcher);

  let nextEntries: MatcherEntry[];

  if (matcherIndex === -1) {
    // No entry for this matcher yet — create one.
    const newCmd = buildHookCommand(command, spec.timeout);
    nextEntries = [...existingEntries, { matcher, hooks: [newCmd] }];
  } else {
    // Entry exists — merge the command into its hooks[] (dedup).
    nextEntries = existingEntries.map((entry, idx) => {
      if (idx !== matcherIndex) {
        return entry;
      }
      const existing = toHookCommands(entry.hooks);
      const alreadyPresent = existing.some((c) => c.command === command);
      if (alreadyPresent) {
        return entry;
      }
      const newCmd = buildHookCommand(command, spec.timeout);
      return { ...entry, hooks: [...existing, newCmd] };
    });
  }

  const nextHooksMap: Record<string, unknown> = { ...hooksMap, [event]: nextEntries };

  return { ...settings, hooks: nextHooksMap };
}

/**
 * Removes the specified command from hooks.<event>[matcher].
 *
 * Cleanup rules (applied in order):
 * 1. Remove the command from the hooks[] of the target matcher.
 * 2. If the matcher's hooks[] is now empty, remove that matcher entry.
 * 3. If the event's entries array is now empty, remove that event key.
 * 4. If the hooks map is now empty, remove the `hooks` key entirely.
 *
 * No-op if the hook (event, matcher, command) is not present.
 * Input is never mutated.
 *
 * @param settings - Current settings object (not mutated).
 * @param spec     - Hook to remove (timeout is irrelevant for removal).
 * @returns A new settings object with the hook removed.
 */
export function removeHook(
  settings: Record<string, unknown>,
  spec: Omit<HookSpec, 'timeout'>,
): Record<string, unknown> {
  const { event, matcher, command } = spec;
  const hooksMap = getHooksMap(settings);
  const existingEntries = toMatcherEntries(hooksMap[event]);

  // Step 1: remove the command from the target matcher.
  const nextEntries = existingEntries
    .map((entry) => {
      if (entry.matcher !== matcher) {
        return entry;
      }
      const filteredCmds = toHookCommands(entry.hooks).filter((c) => c.command !== command);
      return { ...entry, hooks: filteredCmds };
    })
    // Step 2: remove matchers whose hooks[] is now empty.
    .filter((entry) => entry.hooks.length > 0);

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
 * @param settings - Current settings object.
 * @param spec     - Hook to check (timeout is irrelevant for lookup).
 */
export function hasHook(
  settings: Record<string, unknown>,
  spec: Omit<HookSpec, 'timeout'>,
): boolean {
  const { event, matcher, command } = spec;
  const hooksMap = getHooksMap(settings);
  const entries = toMatcherEntries(hooksMap[event]);
  const matcherEntry = entries.find((e) => e.matcher === matcher);
  if (matcherEntry === undefined) {
    return false;
  }
  return toHookCommands(matcherEntry.hooks).some((c) => c.command === command);
}
