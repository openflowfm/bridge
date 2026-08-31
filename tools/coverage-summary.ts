#!/usr/bin/env node
// Renders coverage/coverage-summary.json for the two places outside a terminal
// that a coverage number is any use: GitHub's job summary — the build page
// itself, rather than an artifact somebody has to download — and a shields.io
// endpoint for the README badge.
//
// The markdown goes to $GITHUB_STEP_SUMMARY when CI sets it, stdout otherwise.
// The badge is written into coverage/, which is what gets published to Pages.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

type Counts = { total: number; covered: number; pct: number };
type Entry = { statements: Counts; branches: Counts; functions: Counts; lines: Counts };

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'coverage/coverage-summary.json');

let report: Record<string, Entry>;
try {
  report = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
} catch {
  console.error(`no coverage report at ${relative(root, file)} — run npm run test:coverage`);
  process.exit(1);
}

const { total, ...files } = report;

// The workspace a file belongs to, which is as fine-grained as a build page
// wants to be. Per-file numbers are what the html report is for.
const areaOf = (path: string) => relative(root, path).split('/').slice(0, 2).join('/');

const areas = new Map<string, Entry>();
for (const [path, entry] of Object.entries(files)) {
  const area = areaOf(path);
  const sum = areas.get(area) ?? {
    statements: { total: 0, covered: 0, pct: 0 },
    branches: { total: 0, covered: 0, pct: 0 },
    functions: { total: 0, covered: 0, pct: 0 },
    lines: { total: 0, covered: 0, pct: 0 },
  };
  for (const key of ['statements', 'branches', 'functions', 'lines'] as const) {
    sum[key].total += entry[key].total;
    sum[key].covered += entry[key].covered;
  }
  areas.set(area, sum);
}

const pct = (counts: Counts) => (counts.total === 0 ? 100 : (counts.covered / counts.total) * 100);
const cell = (counts: Counts) => `${pct(counts).toFixed(1)}% <sub>${counts.covered}/${counts.total}</sub>`;

const rows = [...areas.entries()].sort(([, a], [, b]) => pct(a.lines) - pct(b.lines));

const markdown = [
  '## Coverage',
  '',
  `**${total.lines.pct.toFixed(1)}% of lines** — ${total.lines.covered} of ${total.lines.total}, across ${Object.keys(files).length} files.`,
  '',
  '| | statements | branches | functions | lines |',
  '|---|---:|---:|---:|---:|',
  `| **all** | ${cell(total.statements)} | ${cell(total.branches)} | ${cell(total.functions)} | ${cell(total.lines)} |`,
  ...rows.map(
    ([area, sum]) =>
      `| \`${area}\` | ${cell(sum.statements)} | ${cell(sum.branches)} | ${cell(sum.functions)} | ${cell(sum.lines)} |`,
  ),
  '',
  'Line-by-line: the `coverage-<sha>` artifact on this run, `coverage/index.html` inside it.',
  '',
].join('\n');

// A shields.io endpoint, published with the report: a number in the README
// without an account anywhere holding it.
const colour = (percent: number) =>
  percent >= 90 ? 'brightgreen'
  : percent >= 75 ? 'green'
  : percent >= 60 ? 'yellowgreen'
  : percent >= 45 ? 'yellow'
  : percent >= 30 ? 'orange'
  : 'red';

writeFileSync(
  resolve(root, 'coverage/badge.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    label: 'coverage',
    message: `${total.lines.pct.toFixed(1)}%`,
    color: colour(total.lines.pct),
  })}\n`,
);

const out = process.env.GITHUB_STEP_SUMMARY;
if (out) appendFileSync(out, markdown);
else console.log(markdown);
