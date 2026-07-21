/**
 * Tests for core/src/linker.ts — syncToStore, linkOrCopy, link.
 *
 * Canonical suite (Lot 7 / T5, L14): merges the two previously-duplicated
 * suites (this file and the now-deleted `src/linker.test.ts`) into one.
 * The living copy was `src/linker.test.ts` (preserveGlobs + R3 symlink
 * security); this file ports the 8 behaviors that were unique to the old
 * `test/` copy and folds divergent assertions on shared behaviors into a
 * single test rather than keeping near-duplicates.
 *
 * `unlink` / `unlinkTarget` / `removeStoreIfUnreferenced` are out of scope —
 * see linker.unlink.test.ts.
 *
 * Isolation: each test uses a fresh tmp dir via makeTmp(). No real fs outside
 * of tmp.
 *
 * Coverage:
 * - syncToStore file: copies source to store, creates parents, overwrites.
 * - syncToStore dir: mirrors recursively (incl. nested subdirectories),
 *   removes stale entries, replaces the store wholesale.
 * - syncToStore dir with preserveGlobs: copies source files, preserves
 *   matching files, still purges non-matching stale files.
 * - syncToStore — R3: rejects any symlink found in cloned content
 *   (fail-closed), at any depth, for both directory and mono-file sources.
 * - linkOrCopy: creates a symlink; content is readable through it; creates
 *   target parents; is idempotent; re-links a stale/plain target; falls
 *   back to a real (non-symlink) copy — file or directory — when injected
 *   symlink throws.
 * - link: composes syncToStore + linkOrCopy, is idempotent on a second call,
 *   and propagates opts.symlink through to the linkOrCopy fallback.
 * - probeSymlinkSupport (lib-nature T4, R4): reports true on a real symlink
 *   success, false when the injected symlink rejects, and always tears its
 *   scratch directory down either way.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  link,
  linkOrCopy,
  probeSymlinkSupport,
  SymlinkInContentError,
  syncToStore,
} from '../src/linker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linker-test-'));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmp>>;

beforeEach(async () => {
  tmp = await makeTmp();
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// syncToStore — file
// ---------------------------------------------------------------------------

describe('syncToStore — file', () => {
  it('copies source file to store path', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'store', 'target.sh');
    await fs.writeFile(src, '#!/bin/sh\necho hello');

    await syncToStore(src, store);

    const content = await fs.readFile(store, 'utf8');
    expect(content).toBe('#!/bin/sh\necho hello');
  });

  it('creates parent directories for store path', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'deep', 'nested', 'dir', 'target.sh');
    await fs.writeFile(src, 'content');

    await syncToStore(src, store);

    const stat = await fs.stat(store);
    expect(stat.isFile()).toBe(true);
  });

  it('overwrites existing store file', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'store.sh');
    await fs.writeFile(src, 'new content');
    await fs.writeFile(store, 'old content');

    await syncToStore(src, store);

    const content = await fs.readFile(store, 'utf8');
    expect(content).toBe('new content');
  });
});

// ---------------------------------------------------------------------------
// syncToStore — directory (default: rm -rf + cp)
// ---------------------------------------------------------------------------

describe('syncToStore — directory (full mirror)', () => {
  it('copies source directory contents to store, including nested subdirectories', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(path.join(src, 'sub'), { recursive: true });
    await fs.writeFile(path.join(src, 'script.sh'), '#!/bin/sh');
    await fs.writeFile(path.join(src, 'sub', 'nested.ts'), 'export {}');

    await syncToStore(src, store);

    const content = await fs.readFile(path.join(store, 'script.sh'), 'utf8');
    const nested = await fs.readFile(path.join(store, 'sub', 'nested.ts'), 'utf8');
    expect(content).toBe('#!/bin/sh');
    expect(nested).toBe('export {}');
  });

  it('removes stale files in store that are absent from source', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'current.sh'), 'new');
    await fs.writeFile(path.join(store, 'stale.sh'), 'old');

    await syncToStore(src, store);

    const entries = await fs.readdir(store);
    expect(entries).toContain('current.sh');
    expect(entries).not.toContain('stale.sh');
  });

  it('replaces existing store directory entirely', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'v2.sh'), 'v2');
    await fs.writeFile(path.join(store, 'v1.sh'), 'v1');

    await syncToStore(src, store);

    const entries = await fs.readdir(store);
    expect(entries).toContain('v2.sh');
    expect(entries).not.toContain('v1.sh');
  });
});

// ---------------------------------------------------------------------------
// syncToStore — directory with preserveGlobs (non-destructive for matched files)
// ---------------------------------------------------------------------------

describe('syncToStore — directory with preserveGlobs', () => {
  it('preserves guard-*.log files after re-sync', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'guard.sh'), '#!/bin/sh');
    // guard log already present in store (written at runtime by the guard script)
    await fs.writeFile(path.join(store, 'guard-2026-06-23.log'), 'previous run log');

    await syncToStore(src, store, { preserveGlobs: ['guard-*.log'] });

    const logContent = await fs.readFile(path.join(store, 'guard-2026-06-23.log'), 'utf8');
    expect(logContent).toBe('previous run log');
  });

  it('copies source files into store when preserveGlobs is set', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'guard.sh'), '#!/bin/sh guard v2');

    await syncToStore(src, store, { preserveGlobs: ['guard-*.log'] });

    const content = await fs.readFile(path.join(store, 'guard.sh'), 'utf8');
    expect(content).toBe('#!/bin/sh guard v2');
  });

  it('removes stale source files not in source and not matching preserveGlobs', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'current.sh'), 'new');
    // stale.sh exists in store but not in src, and does not match guard-*.log
    await fs.writeFile(path.join(store, 'stale.sh'), 'old');

    await syncToStore(src, store, { preserveGlobs: ['guard-*.log'] });

    const entries = await fs.readdir(store);
    expect(entries).toContain('current.sh');
    expect(entries).not.toContain('stale.sh');
  });

  it('updates an existing source file in store (overwrite)', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'guard.sh'), 'updated');
    await fs.writeFile(path.join(store, 'guard.sh'), 'outdated');

    await syncToStore(src, store, { preserveGlobs: ['guard-*.log'] });

    const content = await fs.readFile(path.join(store, 'guard.sh'), 'utf8');
    expect(content).toBe('updated');
  });

  it('preserves multiple log files matching the glob', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'guard.sh'), '#!/bin/sh');
    await fs.writeFile(path.join(store, 'guard-2026-06-21.log'), 'run 1');
    await fs.writeFile(path.join(store, 'guard-2026-06-22.log'), 'run 2');
    await fs.writeFile(path.join(store, 'guard-2026-06-23.log'), 'run 3');

    await syncToStore(src, store, { preserveGlobs: ['guard-*.log'] });

    const entries = await fs.readdir(store);
    expect(entries).toContain('guard-2026-06-21.log');
    expect(entries).toContain('guard-2026-06-22.log');
    expect(entries).toContain('guard-2026-06-23.log');
  });

  it('creates store directory if it does not exist yet', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store-new');
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, 'guard.sh'), '#!/bin/sh');

    await syncToStore(src, store, { preserveGlobs: ['guard-*.log'] });

    const stat = await fs.stat(path.join(store, 'guard.sh'));
    expect(stat.isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// non-regression: default syncToStore (no preserveGlobs) still mirrors cleanly
// ---------------------------------------------------------------------------

describe('syncToStore — non-regression: default mode ignores any runtime files in store', () => {
  it('does NOT preserve non-source files when no preserveGlobs given', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.mkdir(store);
    await fs.writeFile(path.join(src, 'script.sh'), 'content');
    await fs.writeFile(path.join(store, 'guard-2026-06-23.log'), 'log content');

    // Default call — no preserveGlobs
    await syncToStore(src, store);

    const entries = await fs.readdir(store);
    expect(entries).not.toContain('guard-2026-06-23.log');
    expect(entries).toContain('script.sh');
  });
});

// ---------------------------------------------------------------------------
// syncToStore — R3: rejects symlinks in cloned content (fail-closed)
//
// Threat model: content cloned from an untrusted remote catalog can carry a
// symlink (e.g. `secret -> ~/.ssh/id_rsa`). Scanners like gitleaks/trivy do
// not follow symlinks, so such a link passes the scan gate empty-handed; if
// syncToStore then copied it verbatim, the install symlink would re-expose
// the linked host file. The guard must reject before any byte is written to
// the store.
// ---------------------------------------------------------------------------

describe('syncToStore — R3: rejects symlinks in cloned content (fail-closed)', () => {
  it('rejects an absolute symlink to a host secret, and leaves the store untouched', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    const hostSecret = path.join(tmp.dir, 'host-home', '.ssh', 'id_rsa');
    await fs.mkdir(path.dirname(hostSecret), { recursive: true });
    await fs.writeFile(hostSecret, 'PRIVATE KEY MATERIAL');
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, 'skill.md'), '# ok');
    await fs.symlink(hostSecret, path.join(src, 'secret'));

    await expect(syncToStore(src, store)).rejects.toThrow(SymlinkInContentError);
    await expect(syncToStore(src, store)).rejects.toThrow(/secret/);

    const storeExists = await fs.stat(store).then(() => true).catch(() => false);
    expect(storeExists).toBe(false);
  });

  it('rejects a relative symlink escaping the checkout', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.symlink('../../../../etc/passwd', path.join(src, 'x'));

    await expect(syncToStore(src, store)).rejects.toThrow(SymlinkInContentError);
  });

  it('rejects a symlink pointing to a directory', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    const otherDir = path.join(tmp.dir, 'other-dir');
    await fs.mkdir(src);
    await fs.mkdir(otherDir);
    await fs.symlink(otherDir, path.join(src, 'linked-dir'));

    await expect(syncToStore(src, store)).rejects.toThrow(SymlinkInContentError);
  });

  it('rejects a dangling symlink (target does not exist)', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(src);
    await fs.symlink(path.join(tmp.dir, 'nonexistent-target'), path.join(src, 'broken'));

    await expect(syncToStore(src, store)).rejects.toThrow(SymlinkInContentError);
  });

  it('rejects a symlink nested deep in a subdirectory (full-depth walk)', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    const hostSecret = path.join(tmp.dir, 'host-secret-2');
    await fs.writeFile(hostSecret, 'secret content');
    await fs.mkdir(path.join(src, 'sub', 'inner'), { recursive: true });
    await fs.writeFile(path.join(src, 'sub', 'ok.md'), 'ok');
    await fs.symlink(hostSecret, path.join(src, 'sub', 'inner', 'secret'));

    await expect(syncToStore(src, store)).rejects.toThrow(SymlinkInContentError);
    await expect(syncToStore(src, store)).rejects.toThrow(/sub[/\\]inner[/\\]secret/);
  });

  it('rejects when the mono-file source itself is a symlink', async () => {
    const realFile = path.join(tmp.dir, 'real-agent.md');
    await fs.writeFile(realFile, '# agent');
    await fs.mkdir(path.join(tmp.dir, 'agents'));
    const src = path.join(tmp.dir, 'agents', 'evil.md');
    await fs.symlink(realFile, src);
    const store = path.join(tmp.dir, 'store.md');

    await expect(syncToStore(src, store)).rejects.toThrow(SymlinkInContentError);
  });

  it('non-regression: succeeds for clean content (regular files and subdirectories)', async () => {
    const src = path.join(tmp.dir, 'src');
    const store = path.join(tmp.dir, 'store');
    await fs.mkdir(path.join(src, 'sub'), { recursive: true });
    await fs.writeFile(path.join(src, 'top.md'), 'top');
    await fs.writeFile(path.join(src, 'sub', 'nested.md'), 'nested');

    await syncToStore(src, store);

    const topContent = await fs.readFile(path.join(store, 'top.md'), 'utf8');
    const nestedContent = await fs.readFile(path.join(store, 'sub', 'nested.md'), 'utf8');
    expect(topContent).toBe('top');
    expect(nestedContent).toBe('nested');
  });
});

// ---------------------------------------------------------------------------
// linkOrCopy — symlink path
// ---------------------------------------------------------------------------

describe('linkOrCopy — symlink path', () => {
  it('creates a symlink at targetPath pointing to storePath', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(store, '#!/bin/sh');

    const method = await linkOrCopy(store, target);

    expect(method).toBe('symlink');
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
    const link = await fs.readlink(target);
    expect(link).toBe(store);
  });

  it('reads store content through the target symlink', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(store, 'via symlink');

    await linkOrCopy(store, target);

    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('via symlink');
  });

  it('creates parent directories for targetPath', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const target = path.join(tmp.dir, 'deep', 'nested', 'target.sh');
    await fs.writeFile(store, 'data');

    await linkOrCopy(store, target);

    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('is idempotent when symlink already points to storePath', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(store, '#!/bin/sh');

    await linkOrCopy(store, target);
    const method = await linkOrCopy(store, target);

    expect(method).toBe('symlink');
    const link = await fs.readlink(target);
    expect(link).toBe(store);
  });

  it('re-links when existing symlink points to wrong target', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const other = path.join(tmp.dir, 'other.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(store, '#!/bin/sh');
    await fs.writeFile(other, '#!/bin/sh other');
    await fs.symlink(other, target);

    const method = await linkOrCopy(store, target);

    expect(method).toBe('symlink');
    const link = await fs.readlink(target);
    expect(link).toBe(store);
  });

  it('replaces a plain file at targetPath with a symlink', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(store, 'store content');
    await fs.writeFile(target, 'plain file');

    const method = await linkOrCopy(store, target);

    expect(method).toBe('symlink');
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
  });
});

describe('linkOrCopy — copy fallback', () => {
  it('falls back to copy when symlink throws', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(store, 'content');

    const method = await linkOrCopy(store, target, {
      symlink: () => Promise.reject(new Error('symlink not supported')),
    });

    expect(method).toBe('copy');
    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('content');
  });

  it('target is a real copy, not a symlink, after fallback', async () => {
    const store = path.join(tmp.dir, 'store.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(store, 'content');

    await linkOrCopy(store, target, {
      symlink: () => Promise.reject(new Error('symlink not supported')),
    });

    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it('copy fallback works recursively for a directory store', async () => {
    const store = path.join(tmp.dir, 'store-dir');
    const target = path.join(tmp.dir, 'target-dir');
    await fs.mkdir(path.join(store, 'sub'), { recursive: true });
    await fs.writeFile(path.join(store, 'README.md'), '# readme');

    const method = await linkOrCopy(store, target, {
      symlink: () => Promise.reject(new Error('no symlinks')),
    });

    expect(method).toBe('copy');
    const readme = await fs.readFile(path.join(target, 'README.md'), 'utf8');
    expect(readme).toBe('# readme');
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

describe('link — compose syncToStore + linkOrCopy', () => {
  it('returns method, store, and target', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'store', 'script.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(src, '#!/bin/sh');

    const result = await link(src, store, target);

    expect(result.method).toBe('symlink');
    expect(result.store).toBe(store);
    expect(result.target).toBe(target);
  });

  it('store contains source content after link', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'store', 'script.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(src, 'my script');

    await link(src, store, target);

    const content = await fs.readFile(store, 'utf8');
    expect(content).toBe('my script');
  });

  it('target is a symlink resolving to the store after link', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'store', 'script.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(src, 'linked content');

    await link(src, store, target);

    const resolved = await fs.readlink(target);
    expect(resolved).toBe(store);
  });

  it('is stable on a second call (idempotence)', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'store', 'script.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(src, 'content');

    await link(src, store, target);
    const result2 = await link(src, store, target);

    expect(result2.method).toBe('symlink');
    const resolved = await fs.readlink(target);
    expect(resolved).toBe(store);
  });

  it('propagates opts.symlink to the linkOrCopy fallback', async () => {
    const src = path.join(tmp.dir, 'source.sh');
    const store = path.join(tmp.dir, 'store', 'script.sh');
    const target = path.join(tmp.dir, 'target.sh');
    await fs.writeFile(src, 'content');

    const result = await link(src, store, target, {
      symlink: () => Promise.reject(new Error('no symlinks')),
    });

    expect(result.method).toBe('copy');
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeSymlinkSupport
// ---------------------------------------------------------------------------

describe('probeSymlinkSupport', () => {
  it('returns true when the real fs.symlink succeeds (default, no opts)', async () => {
    expect(await probeSymlinkSupport()).toBe(true);
  });

  it('returns false when the injected symlink rejects', async () => {
    const supported = await probeSymlinkSupport({
      symlink: () => Promise.reject(new Error('ENOSYS: symlink not supported')),
    });
    expect(supported).toBe(false);
  });

  it('leaves no rigger-symlink-probe-* directory behind on success', async () => {
    await probeSymlinkSupport();
    const entries = await fs.readdir(os.tmpdir());
    const leftover = entries.filter((n) => n.startsWith('rigger-symlink-probe-'));
    expect(leftover).toEqual([]);
  });

  it('leaves no rigger-symlink-probe-* directory behind even when the symlink rejects', async () => {
    await probeSymlinkSupport({ symlink: () => Promise.reject(new Error('no symlinks')) });
    const entries = await fs.readdir(os.tmpdir());
    const leftover = entries.filter((n) => n.startsWith('rigger-symlink-probe-'));
    expect(leftover).toEqual([]);
  });

  it('scratches under scratchParentDir (same-filesystem probe) when it exists', async () => {
    let observedLinkPath = '';
    await probeSymlinkSupport({
      scratchParentDir: tmp.dir,
      symlink: (target, dest) => {
        observedLinkPath = dest;
        return fs.symlink(target, dest);
      },
    });
    expect(observedLinkPath.startsWith(tmp.dir)).toBe(true);
  });

  it('falls back to os.tmpdir() when scratchParentDir does not exist', async () => {
    const missingDir = path.join(tmp.dir, 'does-not-exist');
    let observedLinkPath = '';
    await probeSymlinkSupport({
      scratchParentDir: missingDir,
      symlink: (target, dest) => {
        observedLinkPath = dest;
        return fs.symlink(target, dest);
      },
    });
    expect(observedLinkPath.startsWith(missingDir)).toBe(false);
    expect(observedLinkPath.startsWith(os.tmpdir())).toBe(true);
  });

  it('never creates scratchParentDir itself when it does not exist yet', async () => {
    const missingDir = path.join(tmp.dir, 'never-created');
    await probeSymlinkSupport({ scratchParentDir: missingDir });
    const stat = await fs.lstat(missingDir).catch(() => null);
    expect(stat).toBeNull();
  });
});
