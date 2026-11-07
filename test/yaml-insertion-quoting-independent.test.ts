// Copy, count, and model-field insertion. A number-like or punctuated value stays text.
// A plain word that starts with a letter is written bare.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copySeat, rewriteCount, rewriteSeatModel, type SeatModelFields } from '../src/file/lines.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const NUMBER_NAMES = ['123456789012', '123456e78901', '0x1f', '1e5'] as const;

const HEAD = `format: 1
project: harbor
session: hour
operator: guide
workspace:
  mode: shared
seats:
  - role: guide
    name: guide
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
    leads: true
`;

const SCOUT = `${HEAD}  - role: guide
    name: scout
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
`;

function counted(model: string, label?: string): string {
  const written = label === undefined ? '' : `    label: ${label}\n`;
  return `${HEAD}  - role: guide
    name: scout
    cli: codex
    vendor: test
    model: ${model}
    version: "1"
    launch: fixture
${written}    count: 2
`;
}

function hold(name: string, text: string): { base: string; text: string } {
  const base = fixtureBase('yaml-insertion-quoting');
  const path = join(base, name);
  writeFileSync(path, text, { mode: 0o600 });
  return { base, text: readFileSync(path, 'utf8') };
}

function discard(base: string): void {
  discardFixtures([base], { roots: [dirname(base)] });
}

function seatsOf(text: string) {
  const read = validateTeamFile(text);
  expect(read.ok, read.ok ? '' : JSON.stringify(read.errors)).toBe(true);
  if (!read.ok) throw new Error('unreadable team file');
  return read.team.seats;
}

function wrote(text: string, key: string, spelling: string): void {
  expect(text.split('\n').some((line) => line.trim() === `${key}: ${spelling}`)).toBe(true);
}

function fields(model: string, version: string, display: string): SeatModelFields {
  return { cli: 'codex', vendor: 'test', model, version, display, launch: 'fixture' };
}

test('copying an unlabelled seat keeps a number-like name and label as text', () => {
  const scene = hold('copy.yaml', SCOUT);
  try {
    expect(validateTeamFile(scene.text).ok).toBe(true);
    for (const name of NUMBER_NAMES) {
      const edited = copySeat(scene.text, 'scout', name);
      expect(edited).not.toBe(scene.text);
      wrote(edited, 'name', JSON.stringify(name));
      wrote(edited, 'label', JSON.stringify(name));
      const seat = seatsOf(edited).find((item) => item.name === name);
      expect(seat?.name).toBe(name);
      expect(seat?.label).toBe(name);
    }
    const plain = copySeat(scene.text, 'scout', 'scout-2');
    wrote(plain, 'name', 'scout-2');
    wrote(plain, 'label', 'scout-2');
    expect(plain.includes('label: "scout-2"')).toBe(false);
    const seat = seatsOf(plain).find((item) => item.name === 'scout-2');
    expect(seat?.label).toBe('scout-2');
  } finally {
    discard(scene.base);
  }
});

test('a count-generated label keeps a number or punctuation as text', () => {
  const cases = [
    { model: '"Test: Model"', label: 'test: model 1-2' },
    { model: '"Note #tag"', label: 'note #tag 1-2' },
    { model: '"-Mark"', label: '-mark 1-2' },
    { model: '"1e5"', label: '1e5 1-2' },
  ] as const;
  const scene = hold('count.yaml', counted(cases[0].model));
  try {
    for (const item of cases) {
      const source = counted(item.model);
      expect(validateTeamFile(source).ok).toBe(true);
      const edited = rewriteCount(source, 'scout');
      expect(edited).not.toBeNull();
      wrote(edited ?? '', 'label', JSON.stringify(item.label));
      const seat = seatsOf(edited ?? '').find((entry) => entry.name === 'scout-2');
      expect(seat?.label).toBe(item.label);
    }
    const plain = counted('Test', 'scout');
    expect(validateTeamFile(plain).ok).toBe(true);
    const edited = rewriteCount(plain, 'scout');
    wrote(edited ?? '', 'label', 'scout-2');
    expect((edited ?? '').includes('label: "scout-2"')).toBe(false);
    expect(seatsOf(edited ?? '').find((entry) => entry.name === 'scout-2')?.label).toBe('scout-2');
  } finally {
    discard(scene.base);
  }
});

test('an inserted display or model value keeps a number or punctuation as text', () => {
  const scene = hold('model.yaml', HEAD);
  try {
    expect(validateTeamFile(scene.text).ok).toBe(true);
    const stripped = scene.text.split('\n').filter((line) => !/^\s*model:/.test(line)).join('\n');
    const cases = [
      fields('Test: Model', '1', 'Test: Model 1'),
      fields('note #1', '1', 'note #1'),
      fields('-mark', '1', '-mark 1'),
      fields('1e5', '1', '1'),
    ];
    for (const item of cases) {
      const edited = rewriteSeatModel(stripped, 'guide', item);
      wrote(edited, 'model', JSON.stringify(item.model));
      wrote(edited, 'display', JSON.stringify(item.display));
      const seat = seatsOf(edited).find((entry) => entry.name === 'guide');
      expect(seat?.model).toBe(item.model);
      expect(seat?.display).toBe(item.display);
    }
    const plain = rewriteSeatModel(stripped, 'guide', fields('Test', 'guide', 'guide'));
    wrote(plain, 'model', 'Test');
    wrote(plain, 'display', 'guide');
    expect(plain.includes('model: "Test"')).toBe(false);
    expect(plain.includes('display: "guide"')).toBe(false);
    const seat = seatsOf(plain).find((entry) => entry.name === 'guide');
    expect(seat?.model).toBe('Test');
    expect(seat?.display).toBe('guide');
  } finally {
    discard(scene.base);
  }
});
