#!/usr/bin/env node
// Scrapes Cycling '74's LOM page into a scratch file, to be diffed against the
// checked-in bridge/LOM.md after a Live upgrade.
//
//   npm run dev:lom-scrape
//
// It does NOT write bridge/LOM.md, and must not be changed to. That file was
// generator output once and stopped being it: it now carries findings that exist
// in no source — that you cannot write to the LOM from inside an observer
// callback, the session-ring dead end, the mixer paths this app actually uses —
// which a regeneration would delete without saying so. This tool answers "what
// did the upgrade change?"; a human merges the answer.
//
// Two sources, because neither is sufficient alone:
//
//   Cycling '74's LOM page   types and access modes, but pinned to Live 12.1
//   Live's own binary        what the installed version actually exposes, but
//                            with no type or access information at all
//
// The page is Next.js, so the same markup appears twice — rendered in the DOM and
// escaped inside __NEXT_DATA__. Everything is unescaped up front and deduped by
// class name afterwards, rather than guessing which copy is which.
//
// Parsing goes through the page's own `liveapi_*` class names, NOT through
// flattened text. That distinction is load-bearing: once the tags are gone, a
// function name and one of its parameter names are the same shape, and a text
// parser reads `create_scene`'s `index` argument as a sibling function. The
// emitted counts are asserted against the raw class-name counts for exactly this
// reason — a parser that silently drops members is worse than no reference.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'node_modules', '.cache', 'lom-scraped.md');
const CACHE = path.join(root, 'node_modules', '.cache', 'lom.html');
const URL_ = 'https://docs.cycling74.com/legacy/max8/vignettes/live_object_model';

/** Classes reachable from the session grid. Everything else is a device. */
const FULL = [
  'Song', 'Song.View', 'Track', 'Track.View',
  'ClipSlot', 'Clip', 'Clip.View', 'Scene', 'CuePoint', 'Application',
];

interface Member { name: string; type: string; access: string; desc: string }
interface LomClass {
  name: string; path: string; blurb: string;
  children: Member[]; properties: Member[]; functions: Member[];
}

// ---------------------------------------------------------------- fetch

async function source(): Promise<string> {
  if (fs.existsSync(CACHE)) return fs.readFileSync(CACHE, 'utf8');
  const res = await fetch(URL_, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${URL_} answered ${res.status}`);
  const html = await res.text();
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, html);
  return html;
}

// ---------------------------------------------------------------- parse

const strip = (s: string): string =>
  s
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<li[^>]*>/g, '\n• ')
    .replace(/<\/(p|div|li|h\d)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)
    .join('\n').trim();

function parse(raw: string): LomClass[] {
  const html = raw
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')
    .replace(/\\"/g, '"').replace(/\\n/g, '\n');

  const at = [...html.matchAll(/<div class="liveapi_object_section">/g)].map((m) => m.index!);
  at.push(html.length);

  const objects: LomClass[] = [];
  const size = (o: LomClass) => o.children.length + o.properties.length + o.functions.length;

  for (let i = 0; i < at.length - 1; i++) {
    const chunk = html.slice(at[i], at[i + 1]);
    const grab = (re: RegExp) => strip((chunk.match(re) ?? [])[1] ?? '');

    const name = grab(/<h\d[^>]*class="liveapi_object_name"[^>]*>([\s\S]*?)<\/h\d>/);
    if (!name) continue;

    const members = (kind: string): Member[] =>
      [...chunk.matchAll(new RegExp(
        `<div class="liveapi_${kind}_group">([\\s\\S]*?)</div>\\s*` +
        `(?=<div class="liveapi_|<div class="liveapi_object_section"|$)`, 'g',
      ))].map((m) => {
        const g = m[1];
        const one = (re: RegExp) => strip((g.match(re) ?? [])[1] ?? '');
        return {
          name: one(new RegExp(`<h\\d[^>]*class="liveapi_${kind}_name"[^>]*>([\\s\\S]*?)</h\\d>`)),
          type: one(/<div class="type">([\s\S]*?)<\/div>/).replace(/^Type\s*/, ''),
          access: one(/<div class="access">([\s\S]*?)<\/div>/).replace(/^Access\s*/, ''),
          // NOT bounded by `</p>`. A description that continues into a bulleted
          // list is serialised as `…</p><ul><li>…` — the list is a *sibling* that
          // closes the paragraph, so stopping at the first `</p>` silently drops
          // every bullet (this cost `add_warp_marker` its three constraints).
          // The description is the last thing in a group, so run to the next
          // structural boundary instead; no description contains a `<div>`.
          desc: one(/<p class="description">([\s\S]*?)(?=<div class="|<h4|$)/),
        };
      }).filter((m) => m.name);

    const parsed: LomClass = {
      name,
      path: grab(/<h\d[^>]*class="path"[^>]*>([\s\S]*?)<\/h\d>/),
      blurb: grab(/<p class="description">([\s\S]*?)(?=<div class="|<h4|$)/),
      children: members('child'),
      properties: members('property'),
      functions: members('function'),
    };

    // The rendered and the __NEXT_DATA__ copy both land here; keep the fuller one.
    const dup = objects.findIndex((o) => o.name === name);
    if (dup === -1) objects.push(parsed);
    else if (size(parsed) > size(objects[dup])) objects[dup] = parsed;
  }

  // A dropped member is silent damage, so count what the raw markup declares and
  // refuse to emit a reference that doesn't account for all of it.
  const declared = (kind: string) =>
    (raw.match(new RegExp(`class=\\\\?"liveapi_${kind}_group\\\\?"`, 'g')) ?? []).length / 2;
  const got = (k: 'children' | 'properties' | 'functions') =>
    objects.reduce((n, o) => n + o[k].length, 0);

  for (const [kind, k] of [['child', 'children'], ['property', 'properties'], ['function', 'functions']] as const) {
    if (got(k) !== declared(kind)) {
      throw new Error(`parsed ${got(k)} ${k} but the page declares ${declared(kind)} — the parser is dropping members`);
    }
  }
  return objects;
}

// ---------------------------------------------------------------- emit

const cell = (s: string) => (s || '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
const anchor = (n: string) => n.toLowerCase().replace(/\./g, '');

function render(objects: LomClass[]): string {
  const out: string[] = [];
  const w = (s = '') => out.push(s);
  const by = (n: string) => objects.find((o) => o.name === n);

  w('# Scraped LOM tables');
  w();
  w('Scratch output for diffing after a Live upgrade. The reference is');
  w('[`bridge/LOM.md`](../../bridge/LOM.md), which is hand-maintained — merge changes there.');
  w();

  w('## Class index');
  w();
  w('| class | canonical path | children | properties | functions |');
  w('|---|---|---|---|---|');
  for (const o of objects) {
    const link = FULL.includes(o.name) ? `[\`${o.name}\`](#${anchor(o.name)})` : `\`${o.name}\``;
    w(`| ${link} | ${o.path ? '`' + o.path + '`' : '—'} | ${o.children.length} | ${o.properties.length} | ${o.functions.length} |`);
  }
  w();
  w('Device classes are listed for completeness only — `lom.ts` never reaches one, and');
  w('their members are one `strings` away if that ever changes.');
  w();
  w('---');
  w();

  for (const name of FULL) {
    const o = by(name);
    if (!o) continue;
    w(`## ${name}`);
    w();
    if (o.blurb) { w(cell(o.blurb)); w(); }
    if (o.path) { w(`Canonical path: \`${o.path}\``); w(); }

    if (o.children.length) {
      w('### Children');
      w();
      w('| child | type | access |');
      w('|---|---|---|');
      for (const m of o.children) w(`| \`${m.name}\` | ${cell(m.type)} | ${cell(m.access)} |`);
      w();
    }
    if (o.properties.length) {
      w('### Properties');
      w();
      w('| property | type | access | notes |');
      w('|---|---|---|---|');
      for (const m of o.properties) w(`| \`${m.name}\` | ${cell(m.type)} | ${cell(m.access) || '—'} | ${cell(m.desc)} |`);
      w();
    }
    if (o.functions.length) {
      w('### Functions');
      w();
      w('| function | notes |');
      w('|---|---|');
      for (const m of o.functions) w(`| \`${m.name}\` | ${cell(m.desc) || '—'} |`);
      w();
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

const objects = parse(await source());
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, render(objects));

const n = (k: 'children' | 'properties' | 'functions') => objects.reduce((a, o) => a + o[k].length, 0);
const rel = path.relative(root, OUT);
console.log(
  `${rel} — ${objects.length} classes · ${n('children')} children · ` +
  `${n('properties')} properties · ${n('functions')} functions`,
);
console.log(`\nbridge/LOM.md is hand-maintained and was not touched. Compare with:\n` +
  `  git diff --no-index bridge/LOM.md ${rel}`);
