// An empty also_in is not part of the signed record. The 0.5.15 form is the loaded team
// with that empty list left out, the same way an empty messaging map is left out.
// Synthetic team text only.
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { canonicalRecord, canonicalRecordBytes, teamRecordOf } from '../src/file/canonical-record.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';

const SEAT = `seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;

function file(middle = ''): string {
  return `format: 1
project: fixture
coordinator: lead
operator: lead
workspace:
  mode: shared
${middle}${middle === '' ? '' : '\n'}${SEAT}`;
}

const MINIMAL = file();
const WITH_LOBBY = file('lobby: /synthetic/lobby');
const IN_PROJECT = file('in_project: home-project');
const EMPTY_LIST = file('in_project: home-project\nalso_in: []');
const SERVED = file('in_project: home-project\nalso_in:\n  - other-project');

function teamOf(text: string): TeamFile {
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('\n'));
  return loaded.team;
}

function asRecord(team: TeamFile): { seats?: readonly object[] } & Record<string, unknown> {
  return team as unknown as { seats?: readonly object[] } & Record<string, unknown>;
}

/** The record a signature covered before also_in existed: empty also_in is absent. */
function releaseRecord(team: TeamFile): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...team };
  const messaging = copy.messaging;
  if (messaging !== null && typeof messaging === 'object' && !Array.isArray(messaging) && Object.keys(messaging).length === 0) {
    delete copy.messaging;
  }
  if (Array.isArray(copy.alsoIn) && copy.alsoIn.length === 0) delete copy.alsoIn;
  if (!Array.isArray(copy.seats)) return copy;
  return {
    ...copy,
    seats: copy.seats.map((seat) => {
      const { line: _line, ...rest } = seat;
      return rest;
    }),
  };
}

function signedBytes(text: string): Buffer {
  return canonicalRecordBytes(teamRecordOf(asRecord(teamOf(text))));
}

function digest(text: string): string {
  return createHash('sha256').update(signedBytes(text)).digest('hex');
}

test('a team file with no also_in has the 0.5.15 canonical bytes', () => {
  for (const [name, text] of [['minimal', MINIMAL], ['lobby', WITH_LOBBY], ['in_project', IN_PROJECT]] as const) {
    const record = teamRecordOf(asRecord(teamOf(text)));
    expect(record.alsoIn, name).toBeUndefined();
    expect(signedBytes(text), name).toEqual(canonicalRecordBytes(releaseRecord(teamOf(text))));
  }
});

test('a non-empty also_in keeps its exact form', () => {
  const record = teamRecordOf(asRecord(teamOf(SERVED)));
  expect(record.alsoIn).toEqual(['other-project']);
  expect(canonicalRecord(record)).toContain('"alsoIn":["other-project"]');
  expect(signedBytes(SERVED)).toEqual(canonicalRecordBytes(releaseRecord(teamOf(SERVED))));
});

test('adding also_in to a signed file changes the digest', () => {
  expect(digest(IN_PROJECT)).not.toBe(digest(SERVED));
});

test('an explicit also_in: [] equals the omitted form', () => {
  expect(signedBytes(EMPTY_LIST)).toEqual(signedBytes(IN_PROJECT));
  expect(teamRecordOf(asRecord(teamOf(EMPTY_LIST))).alsoIn).toBeUndefined();
  expect(signedBytes(EMPTY_LIST)).toEqual(canonicalRecordBytes(releaseRecord(teamOf(EMPTY_LIST))));
});
