import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal lint: no console.log or debugger statements in src/.
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const bad = walk('src').filter(
  (f) => /\.(js|jsx|ts|tsx)$/.test(f) && /console\.log|debugger/.test(readFileSync(f, 'utf8')),
);
if (bad.length > 0) {
  console.error(`lint: forbidden statement in ${bad.join(', ')}`);
  process.exit(1);
}
console.log('lint: ok');
