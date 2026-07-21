/**
 * layout-skew.ts — turn a raw ENOENT on a checkout convention path into an
 * actionable "layout skew" message (R9, sc. « skew nommé »).
 *
 * The post-cutover CLI derives every checkout path from the `common/` +
 * per-assistant layout (scan-paths, the two adapter builders). When it meets a
 * catalogue that predates the cutover — or, symmetrically, when a pre-cutover
 * CLI is pointed at a post-cutover catalogue — a convention path resolves to a
 * location that exists on one side and not the other, surfacing as a bare ENOENT
 * deep inside the staging copy (`materializeUnion`) or a plugin lookup
 * (`resolveOpencodePluginPath`). A bare ENOENT reads as a corrupt checkout; this
 * names the real cause AND both directions, so the operator reaches for a version
 * alignment rather than a bug report.
 *
 * Wired at the two narrowest choke points every selected artefact passes
 * through: the staging mirror copy (covers skill/agent/hook/guardrail/context/lib
 * — the whole scan union) and the opencode plugin resolver (the one lookup that
 * is not staged content). See R9.3.
 */

/**
 * @param context        Short prefix naming where the miss happened (e.g.
 *                       `scan staging`, `pluginSource: plugin "opencode:x"`).
 * @param conventionPath The checkout-relative (or absolute) path the CLI expected
 *                       under the post-cutover layout but did not find.
 */
export function layoutSkewMessage(context: string, conventionPath: string): string {
  return `${context}: '${conventionPath}' is missing from the checkout.\n`
    + 'The CLI derives this path from the post-cutover layout (common/ + '
    + 'per-assistant dirs — the lib-nature change). The most likely cause is a '
    + 'layout skew between the CLI and the catalogue, in either direction:\n'
    + '  - a CLI at (or after) the lib-nature cutover reading a catalogue that '
    + 'predates it — content still under the flat skills/, agents/, guardrails/, '
    + 'contexts/, plugins/, hooks/ dirs; or\n'
    + '  - a catalogue at the new layout read by a CLI that predates the cutover.\n'
    + 'Align both to the same lib-nature cutover release (or newer): the cutover '
    + 'is a coordinated CLI bump + catalogue tag (D5). Otherwise — CLI and '
    + 'catalogue already aligned — the checkout may simply be missing this path '
    + '(a malformed or incomplete catalogue). Either way, check this path before '
    + 'treating it as a bare ENOENT.';
}
