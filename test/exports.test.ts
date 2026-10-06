import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// runs against the BUILT package (`npm test` builds first): the subpaths, ESM + CJS, and zero `node:`
const dist = new URL('../dist/', import.meta.url);
const require = createRequire(import.meta.url);

describe('the built package', () => {
  it('dist has no node: import and no dependencies (S-46, §5.1)', () => {
    for (const file of readdirSync(dist)) {
      if (file.endsWith('.map')) continue;
      expect(readFileSync(new URL(file, dist), 'utf8'), file).not.toMatch(/node:/);
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toHaveLength(0);
    expect(pkg.engines.node).toBe('>=20');
    expect(pkg.sideEffects).toBe(false);
  });

  it('ESM: the three entries load and share one error hierarchy', async () => {
    const main = await import(new URL('index.js', dist).href);
    const errors = await import(new URL('errors.js', dist).href);
    const webhooks = await import(new URL('webhooks.js', dist).href);
    expect(typeof main.default).toBe('function');
    expect(main.Synergy).toBe(main.default);
    expect(main.SynergyError).toBe(errors.SynergyError);
    expect(typeof webhooks.webhooks.verify).toBe('function');
    await expect(webhooks.verify('x', {}, '')).rejects.toBeInstanceOf(errors.SynergyError);
  });

  it('CJS: the three entries load', () => {
    const main = require('../dist/index.cjs');
    const errors = require('../dist/errors.cjs');
    const webhooks = require('../dist/webhooks.cjs');
    expect(typeof main.Synergy).toBe('function');
    expect(main.SynergyError).toBe(errors.SynergyError);
    expect(typeof webhooks.constructEvent).toBe('function');
  });

  it('./webhooks does not pull the client', () => {
    const source = readFileSync(new URL('webhooks.js', dist), 'utf8');
    expect(source).not.toMatch(/class Synergy\b|fetch\(/);
  });
});
