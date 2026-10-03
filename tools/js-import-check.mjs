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

/*
 * Second pass: catch the inverse mistake — using a sibling module's export
 * WITHOUT importing it. That is a ReferenceError at runtime, but it hides
 * inside try/catch blocks so nothing surfaces until a feature silently stops
 * working (e.g. a mutation that never refreshes because the cache-invalidation
 * call threw first).
 *
 * Only names that some sibling module actually exports are considered, and
 * names declared locally in the file are skipped, so false positives are rare.
 */
const allExports = new Map(); // name -> file that exports it
for (const f of files) {
  for (const n of exportsFor(f)) if (!allExports.has(n)) allExports.set(n, f);
}

for (const file of files) {
  const src = readFileSync(join(DIR, file), 'utf8');
  const imported = new Set(importsOf(src).flatMap((i) => i.names));
  const own = exportsFor(file);
  for (const [name, from] of allExports) {
    if (from === file || imported.has(name) || own.has(name)) continue;
    // Declared locally under the same name? then it shadows legitimately.
    const declared = new RegExp(
      `\\b(?:function|class|const|let|var)\\s+${name}\\b`      // declaration
      + `|\\b${name}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()` // assignment
      + `|^\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`     // class/object method (must open a body)
      + `|[{,]\\s*${name}\\s*[,}:]`,                            // destructured binding
      'm',
    ).test(src);
    if (declared) continue;
    // Only flag bare calls: `clear(` yes, `node.clear(` / `foo.clear =` no.
    // Method calls and property access are the dominant false-positive source.
    if (!new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(src)) continue;
    console.log(`UNIMPORTED EXPORT USED: ${file} uses '${name}' (exported by ${from}) without importing it`);
    problems++;
  }
}

if (problems) { console.log(`\n${problems} problem(s) found.`); process.exit(1); }
console.log(`OK: ${checked} named imports across ${files.length} modules all resolve.`);
