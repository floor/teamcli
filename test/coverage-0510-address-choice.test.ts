// The address a send and a status row both read: a recorded address is used while it stands even
// when the pane cannot be read; a recorded address whose file is gone is `stale`, never a dial;
// and no record with no readable pane is no address at all. One choice, so the two readers can
// never disagree.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketAddressOf } from '../src/send/address.ts';

let root: string;
let sockets: string;
let recorded: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'team-address-choice-'));
  sockets = join(root, 'sockets');
  mkdirSync(sockets, { recursive: true });
  recorded = join(sockets, 'fixture-socket-1.sock');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the shared address choice with no readable pane', () => {
  test('a recorded socket that stands is the address, and says it was recorded', () => {
    writeFileSync(recorded, '');
    expect(socketAddressOf(recorded, null, sockets)).toEqual({
      kind: 'path',
      path: recorded,
      recorded: true,
    });
  });

  test('a recorded socket that is gone is stale, never a dial', () => {
    expect(socketAddressOf(recorded, null, sockets)).toEqual({ kind: 'stale', path: recorded });
  });

  test('no record and no readable pane is no address at all', () => {
    expect(socketAddressOf(null, null, sockets)).toBeNull();
  });
});
