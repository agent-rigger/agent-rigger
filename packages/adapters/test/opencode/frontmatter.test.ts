/**
 * Tests for opencode/frontmatter (TDD — written before implementation).
 *
 * Pure hand-rolled YAML-frontmatter subset (no runtime dependency — the
 * frontmatter used by the catalog's sub-agents is flat `key: value` scalars,
 * occasionally an inline `[a, b]` or one-per-line list, and (on the opencode
 * output side) a one-level-deep nested map like `permission:`).
 *
 * Covers:
 * - parseFrontmatter: real catalog-shaped frontmatter (flat scalars), body preserved exactly.
 * - parseFrontmatter: no frontmatter block → data {}, body === input.
 * - parseFrontmatter: inline list `[a, b]` and one-per-line list.
 * - parseFrontmatter: nested one-level map (e.g. `permission:`).
 * - serializeFrontmatter: flat scalars, arrays, nested maps.
 * - round-trip: parse(serialize(data, body)) recovers an equivalent {data, body}.
 */

import { describe, expect, it } from 'bun:test';

import { parseFrontmatter, serializeFrontmatter } from '../../src/opencode/frontmatter';

describe('parseFrontmatter', () => {
  it('parses flat scalar fields from a real catalog-shaped sub-agent', () => {
    const md = [
      '---',
      'name: reviewer',
      'description: Reviewer agent.',
      'model: opus',
      'tools: Read, Grep, Glob, Bash',
      '---',
      '',
      '# Agent Reviewer',
      '',
      'Body content here.',
      '',
    ].join('\n');

    const { data, body } = parseFrontmatter(md);

    expect(data).toEqual({
      name: 'reviewer',
      description: 'Reviewer agent.',
      model: 'opus',
      tools: 'Read, Grep, Glob, Bash',
    });
    expect(body).toBe('\n# Agent Reviewer\n\nBody content here.\n');
  });

  it('returns data {} and body === input when there is no frontmatter block', () => {
    const md = '# Just a heading\n\nNo frontmatter here.\n';

    const { data, body } = parseFrontmatter(md);

    expect(data).toEqual({});
    expect(body).toBe(md);
  });

  it('parses an inline list value', () => {
    const md = '---\ntags: [a, b, c]\n---\nbody\n';

    const { data } = parseFrontmatter(md);

    expect(data['tags']).toEqual(['a', 'b', 'c']);
  });

  it('parses a one-per-line list value', () => {
    const md = '---\ntags:\n  - a\n  - b\n---\nbody\n';

    const { data } = parseFrontmatter(md);

    expect(data['tags']).toEqual(['a', 'b']);
  });

  it('parses a one-level nested map (e.g. permission)', () => {
    const md = '---\npermission:\n  read: allow\n  edit: deny\n---\nbody\n';

    const { data } = parseFrontmatter(md);

    expect(data['permission']).toEqual({ read: 'allow', edit: 'deny' });
  });

  it('handles an empty frontmatter block', () => {
    const md = '---\n---\nbody\n';

    const { data, body } = parseFrontmatter(md);

    expect(data).toEqual({});
    expect(body).toBe('body\n');
  });
});

describe('serializeFrontmatter', () => {
  it('serializes flat scalars', () => {
    const out = serializeFrontmatter({ name: 'demo', description: 'A demo.' }, 'Body.\n');

    // No blank line is auto-inserted: the caller-supplied `body` (as extracted verbatim
    // by parseFrontmatter, leading blank line included) is appended as-is — this is what
    // keeps parse(serialize(data, body)) an exact round-trip.
    expect(out).toBe('---\nname: demo\ndescription: A demo.\n---\nBody.\n');
  });

  it('serializes an array as an inline list', () => {
    const out = serializeFrontmatter({ tags: ['a', 'b'] }, 'body\n');

    expect(out).toContain('tags: [a, b]');
  });

  it('serializes a nested map one level deep', () => {
    const out = serializeFrontmatter({ permission: { read: 'allow', edit: 'deny' } }, 'body\n');

    expect(out).toContain('permission:');
    expect(out).toContain('  read: allow');
    expect(out).toContain('  edit: deny');
  });

  it('omits undefined values', () => {
    const out = serializeFrontmatter({ name: 'demo', model: undefined }, 'body\n');

    expect(out).not.toContain('model');
  });
});

describe('round-trip', () => {
  it('preserves flat scalar data and body', () => {
    const data = { name: 'demo', description: 'A demo agent.', model: 'anthropic/claude-opus-4-8' };
    const body = '\nBody text.\n';

    const serialized = serializeFrontmatter(data, body);
    const reparsed = parseFrontmatter(serialized);

    expect(reparsed.data).toEqual(data);
    expect(reparsed.body).toBe(body);
  });

  it('preserves a nested permission map', () => {
    const data = { description: 'x', permission: { read: 'allow', bash: 'deny' } };
    const body = 'body\n';

    const reparsed = parseFrontmatter(serializeFrontmatter(data, body));

    expect(reparsed.data).toEqual(data);
    expect(reparsed.body).toBe(body);
  });
});
