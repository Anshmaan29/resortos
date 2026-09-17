// Non-TypeScript files the compiled server loads at runtime. `tsc` only emits .js, so anything
// read with __dirname (the registration card's embedded font, and later invoice assets) has to be
// copied into dist with the same relative path.
import { cpSync, existsSync } from 'node:fs';

const ASSET_DIRS = ['stays/assets'];

for (const dir of ASSET_DIRS) {
  const from = `src/${dir}`;
  if (!existsSync(from)) throw new Error(`Asset directory ${from} is missing`);
  cpSync(from, `dist/${dir}`, { recursive: true });
  console.log(`copied ${from} → dist/${dir}`);
}
