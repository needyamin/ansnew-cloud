#!/usr/bin/env node
// Verify that every named import across the SPA's ES modules resolves to a real
// export. Catches typos that would otherwise only surface as a blank page.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] || '.';
const files = readdirSync(DIR).filter(f => f.endsWith('.js'));

/** Collect exported names from a module source. */
function exportsOf(src) {
  const names = new Set();
  const add = (n) => { if (n) names.add(n); };
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of src.matchAll(/^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      add((as[1] || as[0]).trim());
    }
  }
  if (/^\s*export\s+default/m.test(src)) add('default');
  return names;
}

/** Collect import specifiers from a module source. */
function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(/import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const from = m[2];
    if (!from.startsWith('./')) continue;
    const names = [];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        names.push(seg.split(/\s+as\s+/)[0].trim());
      }
    }
    out.push({ from, names, ns: /^\*\s+as\s+/.test(clause) });
  }
  return out;
}

const cache = new Map();
const exportsFor = (file) => {
  if (!cache.has(file)) cache.set(file, exportsOf(readFileSync(join(DIR, file), 'utf8')));
  return cache.get(file);
};

let problems = 0, checked = 0;
for (const file of files) {
  const src = readFileSync(join(DIR, file), 'utf8');
  for (const imp of importsOf(src)) {
    const target = imp.from.replace(/^\.\//, '');
    if (!files.includes(target)) {
      console.log(`MISSING MODULE: ${file} imports './${target}' which does not exist`);
      problems++;
      continue;
    }
    const avail = exportsFor(target);
    for (const n of imp.names) {
      checked++;
      if (!avail.has(n)) {
        console.log(`MISSING EXPORT: ${file} imports { ${n} } from './${target}' but it is not exported`);
        problems++;
      }
    }
  }
}

if (problems) { console.log(`\n${problems} problem(s) found.`); process.exit(1); }
console.log(`OK: ${checked} named imports across ${files.length} modules all resolve.`);
