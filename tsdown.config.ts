import { defineConfig } from 'tsdown';

// ESM + CJS + .d.ts; three entries = the three subpaths of package.json `exports` (./webhooks never pulls the client)
export default defineConfig({
  entry: ['src/index.ts', 'src/webhooks.ts', 'src/errors.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  platform: 'neutral',
  target: 'es2022',
  fixedExtension: false,
});
