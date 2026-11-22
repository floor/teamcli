// The team's seat_folder setting places a Grok or Cursor seat that names no cwd.
import { expect, test } from 'bun:test';
import { seatFolder, seatFolderOf, SEAT_FOLDER_DEFAULT } from '../src/file/sections/seat_folder.ts';

test('the default is worktrees/{project}/{team}/{seat}', () => {
  expect(SEAT_FOLDER_DEFAULT).toBe('worktrees/{project}/{team}/{seat}');
  expect(seatFolderOf(SEAT_FOLDER_DEFAULT, 'floor', 'jedi', 'argus')).toBe('worktrees/floor/jedi/argus');
});

function validated(text: string | undefined): { value: unknown; failed: string[] } {
  const failed: string[] = [];
  const entry = text === undefined ? undefined : { key: 'seat_folder', line: 3, value: { kind: 'scalar', value: text, raw: text, line: 3 } };
  const check = {
    text: (got: typeof entry) => (got === undefined ? undefined : (got.value as { value: string }).value),
    fail: (_line: number, message: string) => { failed.push(message); },
  };
  const value = seatFolder.validate(entry as never, { check } as never);
  return { value, failed };
}

test('an absent setting is the default; a good one is kept', () => {
  expect(validated(undefined).value).toBe(SEAT_FOLDER_DEFAULT);
  expect(validated('seats/{team}/{seat}')).toEqual({ value: 'seats/{team}/{seat}', failed: [] });
});

test('absolute, home, parent, seatless and unknown words are refused', () => {
  for (const bad of ['/abs/{seat}', '~/x/{seat}', '../out/{seat}', 'worktrees/{team}', 'w/{who}/{seat}']) {
    const got = validated(bad);
    expect(got.failed.length, bad).toBe(1);
    expect(got.value, bad).toBe(SEAT_FOLDER_DEFAULT);
  }
});
