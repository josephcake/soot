#!/usr/bin/env node
/**
 * Check that relative markdown and HTML image links in the repo resolve.
 *
 * Usage: node scripts/check-doc-links.mjs
 *
 * Skips fenced code blocks. Historical research notes under docs/research/
 * (other than docs/research/README.md) are excluded: they link to sibling
 * research files that were never copied into this repository.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.pnpm-store']);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (entry.name.endsWith('.md')) acc.push(path);
  }
  return acc;
}

function shouldCheck(file) {
  const rel = relative(root, file).split('\\').join('/');
  if (rel.startsWith('docs/research/') && rel !== 'docs/research/README.md') return false;
  return true;
}

/** Blank out fenced code so ```...``` does not contribute links. */
function withoutFences(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '));
}

function extractTargets(text) {
  const targets = [];
  const body = withoutFences(text);
  const md = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = md.exec(body))) {
    targets.push({ raw: match[1].trim(), index: match.index });
  }
  const html = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((match = html.exec(body))) {
    targets.push({ raw: match[1].trim(), index: match.index });
  }
  const ref = /^\s*\[[^\]]+\]:\s+(\S+)/gm;
  while ((match = ref.exec(body))) {
    targets.push({ raw: match[1].trim(), index: match.index });
  }
  return targets;
}

function isExternal(url) {
  return /^(https?:|mailto:|data:)/i.test(url) || url.startsWith('#');
}

function stripUrl(raw) {
  // Markdown: <url>, "title", or url "title"
  let url = raw;
  if (url.startsWith('<') && url.includes('>')) url = url.slice(1, url.indexOf('>'));
  const space = url.search(/\s/);
  if (space !== -1) url = url.slice(0, space);
  const hash = url.indexOf('#');
  if (hash !== -1) url = url.slice(0, hash);
  return url;
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

const files = walk(root).filter(shouldCheck);
const broken = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const relFile = relative(root, file).split('\\').join('/');
  for (const { raw, index } of extractTargets(text)) {
    const url = stripUrl(raw);
    if (!url || isExternal(url)) continue;
    checked += 1;
    const target = resolve(dirname(file), url);
    if (!existsSync(target)) {
      broken.push({
        file: relFile,
        line: lineNumber(text, index),
        url,
      });
    }
  }
}

if (broken.length > 0) {
  console.error(`Broken relative links: ${broken.length} (checked ${checked})`);
  for (const hit of broken) {
    console.error(`  ${hit.file}:${hit.line}: ${hit.url}`);
  }
  process.exit(1);
}

console.log(`OK: ${checked} relative links resolved in ${files.length} markdown files.`);
