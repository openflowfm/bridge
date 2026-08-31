#!/usr/bin/env node
// Asks the only question worth asking about a regression net: would it notice?
//
//   npm run dev:mutate -- set/src/lib/chainStore.ts
//
// Breaks the source one small edit at a time — a `<` for a `<=`, a `&&` for an
// `||`, a `true` for a `false` — and runs the colocated spec against each. A
// mutant the spec fails on is *killed*: something in there was watching that
// line. A mutant that survives is a line the spec lights up in the coverage
// report and does not actually check.
//
// That distinction is the whole point when the tests are characterization
// rather than specification. A spec written against already-validated
// behaviour can't be judged on whether it asserts the *right* thing — we have
// already decided the current behaviour is the right thing. All that is left
// to judge is whether it would catch the behaviour changing, and coverage
// cannot answer that. This can.
//
// The file is edited in place and restored afterwards, so it refuses to start
// unless git says it is clean: if this is ever killed mid-run, the recovery is
// `git checkout -- <file>` and nothing is lost.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

interface Mutant {
  /** Offset into the source, and what replaces what. */
  start: number;
  end: number;
  from: string;
  to: string;
  line: number;
}

/** Collapsed to one line and shortened, so a survivor reads as one grep-able row. */
const label = (text: string) => {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 42 ? `${flat.slice(0, 39)}...` : flat;
};

/** Operator swaps, both ways. Each pair is two mutants wherever it appears. */
const SWAPS: [string, string][] = [
  ['<', '<='],
  ['>', '>='],
  ['===', '!=='],
  ['==', '!='],
  ['&&', '||'],
  ['+', '-'],
  ['*', '/'],
];

const root = resolve(import.meta.dirname, '..');
const arg = process.argv[2];
const budget = Number(process.env.OPENFLOW_MUTANTS ?? 40);

if (!arg) {
  console.error('usage: npm run dev:mutate -- <source file>');
  process.exit(1);
}

const file = resolve(root, arg);
const shown = relative(root, file);
const specs = specsFor(file);

if (specs.length === 0) {
  console.error(`no spec beside ${shown} — expected ${basename(file).replace(/\.tsx?$/, '.test$&')}`);
  process.exit(1);
}

// A dirty file would be restored to the wrong content, and worse, a crash
// mid-run would leave a mutation looking like work in progress.
const dirty = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: root });
if (dirty.stdout.toString().trim()) {
  console.error(`${shown} has uncommitted changes — commit or stash before mutating it`);
  process.exit(1);
}

const vitest = resolve(root, 'node_modules/.bin/vitest');
const original = readFileSync(file, 'utf8');
const source = ts.createSourceFile(file, original, ts.ScriptTarget.ESNext, true);
const mutants = collect(source, original);

if (mutants.length === 0) {
  console.error(`nothing to mutate in ${shown}`);
  process.exit(1);
}

// Deterministic thinning rather than the first N, so a long file is sampled
// across its whole length instead of having its tail go unexamined.
const step = Math.max(1, Math.ceil(mutants.length / budget));
const chosen = mutants.filter((_, i) => i % step === 0);

console.log(
  `${shown}: ${chosen.length} mutants of ${mutants.length}, against ` +
    specs.map((s) => basename(s)).join(' + '),
);

const survivors: Mutant[] = [];
process.on('exit', () => writeFileSync(file, original));

for (const [i, mutant] of chosen.entries()) {
  writeFileSync(file, splice(original, mutant));
  const run = spawnSync(vitest, ['run', ...specs, '--reporter=dot'], {
    cwd: root,
    stdio: 'ignore',
  });
  const killed = run.status !== 0;
  if (!killed) survivors.push(mutant);
  process.stdout.write(killed ? '.' : 'S');
  if ((i + 1) % 50 === 0) process.stdout.write('\n');
}

writeFileSync(file, original);
console.log('\n');

if (survivors.length === 0) {
  console.log(`all ${chosen.length} killed — every mutation this makes, the spec notices`);
  process.exit(0);
}

console.log(`${survivors.length} of ${chosen.length} survived — changes the spec would not notice:`);
for (const mutant of survivors) {
  console.log(`  ${shown}:${mutant.line}  ${mutant.from} -> ${mutant.to}`);
}
process.exitCode = 1;

/**
 * Every spec that speaks for this file: `X.test.ts`, and any `X.<aspect>.test.ts`
 * beside it. A hook whose gestures need a DOM keeps them in a second file so the
 * derivation half stays in `environment: node` — and a gate that ran only the
 * first would call the gestures unwatched when they are the best-watched part.
 */
function specsFor(source: string): string[] {
  const base = basename(source).replace(/\.tsx?$/, '');
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(\\.[^.]+)?\\.test\\.tsx?$`);
  const dir = dirname(source);
  return readdirSync(dir)
    .filter((entry) => pattern.test(entry))
    .sort()
    .map((entry) => resolve(dir, entry));
}

function collect(node: ts.SourceFile, text: string): Mutant[] {
  const found: Mutant[] = [];
  const at = (pos: number) => node.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (n: ts.Node): void => {
    // `a ?? b` becomes `b`: the fallback, always. Plumbing code is mostly
    // fallbacks and has no operator to swap, so without this a file that only
    // reshapes data reports nothing to mutate — which reads like a pass and is
    // the opposite of one.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      found.push({
        start: n.getStart(node),
        end: n.getEnd(),
        from: label(n.getText()),
        to: label(n.right.getText()),
        line: at(n.getStart(node)),
      });
    }
    if (ts.isBinaryExpression(n)) {
      const token = n.operatorToken;
      const from = token.getText();
      for (const [a, b] of SWAPS) {
        const to = from === a ? b : from === b ? a : null;
        if (to === null) continue;
        // `+` on strings is concatenation; swapping it for `-` produces NaN
        // rather than a different answer, which is a mutant nothing needs a
        // test to notice.
        if (from === '+' && looksTextual(n)) break;
        found.push({ start: token.getStart(node), end: token.getEnd(), from, to, line: at(token.getStart(node)) });
        break;
      }
    }
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) {
      const from = n.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false';
      found.push({ start: n.getStart(node), end: n.getEnd(), from, to: from === 'true' ? 'false' : 'true', line: at(n.getStart(node)) });
    }
    if (ts.isNumericLiteral(n)) {
      const from = n.getText();
      const value = Number(from);
      if (Number.isFinite(value)) {
        found.push({ start: n.getStart(node), end: n.getEnd(), from, to: String(value + 1), line: at(n.getStart(node)) });
      }
    }
    ts.forEachChild(n, visit);
  };

  ts.forEachChild(node, visit);
  return found.sort((a, b) => a.start - b.start);
}

/** A `+` with a string literal on either side, as far as syntax can tell. */
function looksTextual(n: ts.BinaryExpression): boolean {
  const textual = (side: ts.Expression) =>
    ts.isStringLiteral(side) || ts.isTemplateExpression(side) || ts.isNoSubstitutionTemplateLiteral(side);
  return textual(n.left) || textual(n.right);
}

function splice(text: string, mutant: Mutant): string {
  return text.slice(0, mutant.start) + mutant.to + text.slice(mutant.end);
}
