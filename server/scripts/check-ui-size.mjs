import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const files = readdirSync('dist/web/client/assets').filter((file) => file.endsWith('.js'));
const bytes = files.reduce((total, file) => total + gzipSync(readFileSync(`dist/web/client/assets/${file}`)).length, 0);
if (bytes > 20_000) throw new Error(`Launcher JavaScript exceeds 20 kB gzip: ${bytes} bytes`);
console.log(`Launcher JavaScript: ${bytes} / 20000 bytes gzip`);
