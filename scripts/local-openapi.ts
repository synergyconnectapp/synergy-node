// Writes the `openapi.json` this repo's server code would publish, for `npm run test:contract` while staging does not
// have the code yet (devtools.md §5.7). Run from the monorepo only: `npx tsx scripts/local-openapi.ts [out.json]`.
import { writeFileSync } from 'node:fs';
import { openapi } from '../../../src/api/public/openapi';

const out = process.argv[2] ?? '.openapi-local.json';
writeFileSync(out, `${JSON.stringify(openapi, null, 2)}\n`);
console.log(`wrote ${out}: ${Object.keys(openapi.paths).length} paths`);
