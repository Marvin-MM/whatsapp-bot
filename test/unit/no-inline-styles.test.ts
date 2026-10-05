import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The page policy allows inline style ATTRIBUTES for one reason: Recharts renders one. Our own markup uses Tailwind classes (and SVG for the one
 * dynamic-width bar), so a `style={...}` in src is a new exemption nobody decided on: it fails here until someone does.
 */
const ROOT = process.cwd();

function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...componentFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('no inline style attributes in our own markup', () => {
  const files = componentFiles(join(ROOT, 'src'));

  it('scans the components (guards the guard against scanning nothing)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('finds no style={...} prop', () => {
    const offenders = files.filter((file) => /\bstyle=\{/.test(readFileSync(file, 'utf8'))).map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
