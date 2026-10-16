import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';
import so from '../src/i18n/so.json';
import ar from '../src/i18n/ar.json';

const PLURAL = /_(zero|one|two|few|many|other)$/;

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`.replace(PLURAL, '')],
  );
}
const unique = (o: object) => [...new Set(keys(o))].sort();

describe('translations', () => {
  it('Somali and Arabic cover exactly the English keys', () => {
    expect(unique(so)).toEqual(unique(en));
    expect(unique(ar)).toEqual(unique(en));
  });

  it('Arabic plural keys have every Arabic plural form', () => {
    const flat = keys(ar).length;
    expect(flat).toBeGreaterThan(0);
    for (const base of ['logout_pending', 'pending']) {
      const section = base === 'pending' ? ar.sync : ar.auth;
      for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) {
        expect(section).toHaveProperty(`${base}_${form}`);
      }
    }
  });

  it('every literal key used in the code exists', () => {
    const dir = path.join(__dirname, '..', 'src');
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
    const known = new Set(unique(en));
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-z_]+(?:\.[a-z_A-Z]+)+)'/g)) {
        if (!known.has(m[1])) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
