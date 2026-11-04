// Writes out/marketplace-readme.md: the README of the detail page. The page shows icon, name and publisher in its
// header, so the logo block, the heading and the sections Security and Documentation are left out.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let text = readFileSync(join(root, 'README.md'), 'utf8');

text = text.replace(/^<p align="center">[\s\S]*?<\/p>\s*# aantje\s*/, '');
text = text
  .replace(/^## Security\r?\n[\s\S]*?(?=^## )/m, '')
  .replace(/^## Documentation\r?\n[\s\S]*?(?=^## )/m, '');
if (/^## (Security|Documentation)$/m.test(text) || text.includes('logo.png')) {
  throw new Error('README.md has changed its shape; adjust scripts/marketplace-readme.mjs.');
}

mkdirSync(join(root, 'out'), { recursive: true });
writeFileSync(join(root, 'out', 'marketplace-readme.md'), text);
