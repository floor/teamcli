// The process table's own reader: every platform word stays in the adapter, and the shapes are
// the ones this machine's query printed — measured on 2026-11-04 with
// `ps -axo pid=,comm=,lstart=` (1270 lines in 98 ms):
//
//        1 /sbin/launchd    Mon Nov  2 05:06:00 2026
//      346 /usr/libexec/log Mon Nov  2 05:07:26 2026
/*
  12446 codex           Wed Nov  4 13:47:44 2026
  3533 /opt/lab/packages/example/releases/1.2.3/bin/codex Wed Nov  4 11:02:31 2026
  849 /System/Library/PrivateFrameworks/TextInputUIMacHelper.framework/Versions/A/XPCServices/CursorUIViewService.xpc/Contents/MacOS/CursorUIViewService Mon Nov  2 05:06:00 2026
  28734 Grok Bot        Mon Nov  2 05:06:41 2026
*/
import { describe, expect, test } from 'bun:test';
import {
  parseProcessTable,
  processCommOf,
  processFoldersOf,
  processStartOf,
  processTable,
} from '../src/watch/process-adapter.ts';

/** The table as the query prints it, trailing spaces included, with one row this machine saw and
 *  two shapes a process name takes: a full path, and a display name with a space in it. */
const MEASURED = [
  '      1 /sbin/launchd    Mon Nov  2 05:06:00 2026    ',
  '  12446 codex           Wed Nov  4 13:47:44 2026    ',
  '   3533 /opt/lab/packages/example/releases/1.2.3/bin/codex Wed Nov  4 11:02:31 2026    ',
  '  28734 Grok Bot        Mon Nov  2 05:06:41 2026    ',
].join('\n');

describe('the process table adapter', () => {
  test('reads the query shape, a path name, and a name with a space in it', () => {
    const rows = parseProcessTable(MEASURED);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ pid: 1, comm: '/sbin/launchd', startedAtMs: Date.parse('Mon Nov  2 05:06:00 2026') });
    expect(rows[1]).toEqual({ pid: 12446, comm: 'codex', startedAtMs: Date.parse('Wed Nov  4 13:47:44 2026') });
    expect(rows[2]?.comm).toBe('/opt/lab/packages/example/releases/1.2.3/bin/codex');
    // The name a person sees in the process list; the start instant still reads from the tail.
    expect(rows[3]).toEqual({ pid: 28734, comm: 'Grok Bot', startedAtMs: Date.parse('Mon Nov  2 05:06:41 2026') });
  });

  test('skips a line it cannot read whole rather than guessing one', () => {
    const rows = parseProcessTable([
      '  12446 codex           Wed Nov  4 13:47:44 2026',
      'not a row at all',
      '  123 a name with no start instant',
      '  124 a name with a bad instant Mon Foo  2 05:06:41 2026',
      '  -1 negative',
      '',
    ].join('\n'));
    expect(rows).toEqual([{ pid: 12446, comm: 'codex', startedAtMs: Date.parse('Wed Nov  4 13:47:44 2026') }]);
  });

  test('the table holds this process, and its comm and start instant read back', () => {
    const table = processTable();
    expect(table).not.toBeNull();
    const mine = table?.find((row) => row.pid === process.pid);
    expect(mine).toBeDefined();
    expect(mine?.comm).toBe(processCommOf(process.pid) as string);
    const start = processStartOf(process.pid);
    expect(start).not.toBeNull();
    expect(Math.abs((start as number) - (mine?.startedAtMs as number))).toBeLessThan(60_000);
    // The query prints the machine's local wall clock; this runner's own clock reads in UTC, so
    // the instant can sit a zone away from `Date.now()` here. The scene still catches a parse
    // that lands anywhere but the process's own recent start.
    expect(Math.abs(Date.now() - (start as number))).toBeLessThan(24 * 60 * 60_000);
  });

  test('a dead pid reads as no name and no start instant', () => {
    expect(processCommOf(999_999)).toBeNull();
    expect(processStartOf(999_999)).toBeNull();
  });

  test('one folder read answers many pids, a dead one as null', () => {
    const folders = processFoldersOf([process.pid, 999_999]);
    expect(folders).not.toBeNull();
    expect(folders?.get(process.pid)).toBe(process.cwd());
    expect(folders?.get(999_999)).toBeNull();
    expect(processFoldersOf([])?.size).toBe(0);
  });
});
