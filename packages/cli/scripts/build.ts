#!/usr/bin/env bun
/**
 * build.ts — compile the standalone `agent-rigger` binary, injecting the
 * git-derived version as the `__AR_VERSION__` define.
 *
 * The value is `git describe --tags --always --dirty` with a leading "v"
 * stripped (via the same `normalizeVersion` the runtime resolver uses, so the
 * two never drift). When git is unavailable — no repo, `git` missing — the
 * describe yields "", the define is omitted, and `cli.ts` falls back to the
 * package.json version (the sentinel locally, the stamped tag in release CI).
 *
 * Note: the release workflow does NOT call this script; it stamps package.json
 * with the tag and compiles directly, relying on that fallback. This script is
 * the source-build path (`bun run build`), where reporting the real git state
 * is exactly what we want.
 */

import { spawnSync } from 'node:child_process';

import { normalizeVersion } from '../src/version';

function gitDescribe(): string {
  const res = spawnSync('git', ['describe', '--tags', '--always', '--dirty'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return '';
  return normalizeVersion(res.stdout);
}

const version = gitDescribe();

const args = ['build', '--compile', '--outfile', 'dist/agent-rigger'];
if (version.length > 0) {
  // bun's --define takes a JS expression; JSON.stringify produces a quoted
  // string literal, e.g. __AR_VERSION__="0.1.2". spawnSync bypasses the shell,
  // so the quotes reach bun intact (no shell-quoting dance).
  args.push('--define', `__AR_VERSION__=${JSON.stringify(version)}`);
  console.info(`[build] __AR_VERSION__=${version}`);
} else {
  console.info('[build] git version unavailable — falling back to package.json');
}
args.push('src/cli.ts');

const build = spawnSync('bun', args, { stdio: 'inherit' });
process.exit(build.status ?? 1);
