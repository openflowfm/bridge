// docs/ -> the GitHub wiki.
//
// The wiki is a *separate git repository* (`<repo>.wiki.git`) whose pages are
// flat — no directories, and a page is addressed by its filename with the `.md`
// dropped. So publishing means renaming the files and rewriting every link
// between them. `docs/` stays the source; the wiki is generated output, the same
// way `bridge/public/` is.
//
// Run: node tools/wiki-sync.ts <out-dir>

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname` — the latter percent-encodes, and this repo
// lives under a path with a space in it. Same trap as the amxd CLI; see
// tools/README.md.
const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));

// docs filename -> wiki page name. GitHub renders a page's hyphens as spaces in
// the title, so these read as sentences in the sidebar and the page header.
// `Home` is special: it's the wiki's landing page.
const PAGES: Record<string, string> = {
  'README.md': 'Home',
  'installing.md': 'Installing',
  'the-grid.md': 'Reading-the-grid',
  'playing.md': 'Playing-things',
  'naming.md': 'Naming',
  'roles.md': 'Roles',
  'color.md': 'Color',
  'running-order.md': 'The-running-order',
  'undo.md': 'Undo',
  'keyboard.md': 'Keyboard-reference',
  'troubleshooting.md': 'Troubleshooting',
};

// The sidebar's order, which is the reading order — not alphabetical.
const NAV: Array<[string, string]> = [
  ['Installing', 'Installing'],
  ['Reading the grid', 'Reading-the-grid'],
  ['Playing things', 'Playing-things'],
  ['Naming', 'Naming'],
  ['Roles', 'Roles'],
  ['Color', 'Color'],
  ['The running order', 'The-running-order'],
  ['Undo', 'Undo'],
  ['Keyboard reference', 'Keyboard-reference'],
  ['Troubleshooting', 'Troubleshooting'],
];

/**
 * Rewrite links between docs pages to their wiki page names. Anything that
 * isn't a known page is left alone — an unmapped `.md` link would 404 on the
 * wiki, so it fails the build below rather than shipping broken.
 */
function rewrite(body: string, unknown: Set<string>): string {
  return body.replace(/\]\(\.?\/?([A-Za-z0-9._-]+\.md)(#[^)]*)?\)/g, (whole, file: string, hash = '') => {
    const page = PAGES[file];
    if (!page) {
      unknown.add(file);
      return whole;
    }
    return `](${page}${hash})`;
  });
}

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/wiki-sync.ts <out-dir>');
  process.exit(1);
}

mkdirSync(out, { recursive: true });

const found = readdirSync(DOCS).filter((f) => f.endsWith('.md'));
const missing = found.filter((f) => !PAGES[f]);
if (missing.length) {
  // A new docs page that nobody mapped would silently never reach the wiki.
  console.error(`docs/ has pages with no wiki mapping: ${missing.join(', ')}`);
  console.error('add them to PAGES in tools/wiki-sync.ts');
  process.exit(1);
}

const unknown = new Set<string>();
for (const file of found) {
  const body = rewrite(readFileSync(join(DOCS, file), 'utf8'), unknown);
  writeFileSync(join(out, `${PAGES[file]}.md`), body);
}

if (unknown.size) {
  console.error(`links to unmapped pages: ${[...unknown].join(', ')}`);
  process.exit(1);
}

const sidebar = [
  '### [User manual](Home)',
  '',
  ...NAV.map(([label, page]) => `- [${label}](${page})`),
  '',
  '---',
  '',
  '[Source on GitHub](https://github.com/ryangavin/better-session-view)',
  '',
].join('\n');
writeFileSync(join(out, '_Sidebar.md'), sidebar);

// The wiki has no equivalent of "you are reading a generated file", so say it
// on every page's footer via the shared footer GitHub renders under each one.
const footer = [
  '',
  '_This manual is generated from [`docs/`](https://github.com/ryangavin/better-session-view/tree/main/docs)',
  'in the main repository. Edits made here are overwritten on the next sync — open a PR against `docs/` instead._',
  '',
].join('\n');
writeFileSync(join(out, '_Footer.md'), footer);

console.log(`wrote ${found.length} pages + sidebar + footer to ${out}`);
