// Pre-flight checks that the extension will actually load unpacked in Chrome.
// Run: npm run check
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

let problems = 0;
const fail = (msg) => { console.log(`  FAIL ${msg}`); problems++; };
const ok = (msg) => console.log(`  ok   ${msg}`);

// ------------------------------------------------------------------- syntax

console.log('\n== syntax ==');
const jsFiles = globSync('{src,tools,test}/**/*.{js,mjs}');
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(`${file}: ${String(e.stderr || e).split('\n')[0]}`);
  }
}
if (!problems) ok(`${jsFiles.length} JavaScript files parse`);

// ----------------------------------------------------------------- manifest

console.log('\n== manifest ==');
let manifest;
try {
  manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  ok('manifest.json is valid JSON');
} catch (e) {
  fail(`manifest.json does not parse: ${e.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
else ok('Manifest V3');

for (const key of ['name', 'version', 'description']) {
  if (!manifest[key]) fail(`manifest is missing "${key}"`);
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
  fail(`version "${manifest.version}" is not a valid Chrome version string`);
} else {
  ok(`version ${manifest.version}`);
}

// Chrome refuses to load if any referenced file is absent.
const refs = new Set();
if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
if (manifest.options_page) refs.add(manifest.options_page);
for (const p of Object.values(manifest.action?.default_icon || {})) refs.add(p);
for (const p of Object.values(manifest.icons || {})) refs.add(p);
for (const cs of manifest.content_scripts || []) {
  for (const p of cs.js || []) refs.add(p);
  for (const p of cs.css || []) refs.add(p);
}
for (const war of manifest.web_accessible_resources || []) {
  for (const p of war.resources || []) refs.add(p);
}

let missing = 0;
for (const ref of refs) {
  if (!existsSync(ref)) { fail(`manifest references a missing file: ${ref}`); missing++; }
}
if (!missing) ok(`${refs.size} referenced files all exist`);

// A stray "alarms" permission would let the extension poll a school server on a
// timer, which the safety design explicitly rules out.
if ((manifest.permissions || []).includes('alarms')) {
  fail('"alarms" permission present - the extension must not be able to poll on a timer');
} else {
  ok('no "alarms" permission (cannot poll on a timer)');
}

const worldScripts = (manifest.content_scripts || []).filter((cs) => cs.world === 'MAIN');
if (worldScripts.length && Number(manifest.minimum_chrome_version || 0) < 111) {
  fail('content scripts use world:"MAIN", which needs minimum_chrome_version >= 111');
} else {
  ok('minimum_chrome_version is compatible with the features used');
}

// ---------------------------------------------------------------- html refs

console.log('\n== pages ==');
let htmlRefs = 0;
let htmlMissing = 0;
for (const dir of ['src/ui']) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(dir, file), 'utf8');

    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (m[1].startsWith('http') || m[1] === '#') continue;
      htmlRefs++;
      if (!existsSync(join(dir, m[1]))) {
        fail(`${file} references a missing file: ${m[1]}`);
        htmlMissing++;
      }
    }

    // MV3's content security policy forbids inline script in extension pages.
    if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html)) {
      fail(`${file} contains an inline <script> block, which MV3 blocks`);
    }
    if (/\son(click|change|input|submit|load)=/i.test(html)) {
      fail(`${file} uses an inline event handler attribute, which MV3 blocks`);
    }
  }
}
if (!htmlMissing) ok(`${htmlRefs} local references in HTML all resolve`);

// -------------------------------------------------------------------- done

console.log(problems ? `\n${problems} problem(s) found\n` : '\nReady to load unpacked.\n');
process.exit(problems ? 1 : 0);
