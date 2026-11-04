import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  hostConfigCheck,
  isHerdrError,
  paneRead,
  reloadConfig,
  reportDisplayAgent,
  sessionCleared,
  sessionStopped,
  setCaptureExec,
  setHerdrRun,
  setPaneExec,
  SIDEBAR_TTL_CAP_MS,
  workspacePanes,
} from '../src/herdr.ts';

const PANE_ONE = ['w1', 'p1'].join(':');
const PANE_TWO = ['w1', 'p2'].join(':');
// The captured entries name the runtime temp folder; the capture's own folder is not a value
// any scene reads, so this machine's stands in.
const TEMP = realpathSync(tmpdir());

function capturedPaneEntry(paneId: string, workspaceId: string, terminalId: string) {
  return {
    agent_status: 'unknown',
    cwd: TEMP,
    focused: true,
    foreground_cwd: TEMP,
    pane_id: paneId,
    revision: 0,
    tab_id: `${workspaceId}:t1`,
    terminal_id: terminalId,
    workspace_id: workspaceId,
  };
}

// paneRead's process call is injectable, so these tests ask what it requests, what it falls
// back to and when it gives up — without a live herdr. The timeout error it must recognise
// is the one execFileSync really throws: an Error with code ETIMEDOUT, signal SIGTERM and
// status null — and no killed field.
describe('paneRead', () => {
  afterEach(() => setPaneExec(null));

  test('the styled read is the first call, its CRLF folded', () => {
    const calls: string[][] = [];
    setPaneExec((args) => {
      calls.push(args);
      return 'a\r\nb\r\n';
    });
    expect(paneRead('%1', 8)).toBe('a\nb\n');
    expect(calls.length).toBe(1);
    expect(calls[0]?.at(-2)).toBe('--format');
    expect(calls[0]?.at(-1)).toBe('ansi');
  });

  test('an herdr without --format falls back to the exact call main makes', () => {
    const calls: string[][] = [];
    setPaneExec((args) => {
      calls.push(args);
      if (args.includes('--format')) throw new Error('unknown option --format');
      return 'plain\n';
    });
    expect(paneRead('%1', 8)).toBe('plain\n');
    expect(calls.length).toBe(2);
    expect(calls[1]?.includes('--format')).toBe(false);
    expect(calls[1]?.at(-1)).toBe('8');
  });

  test('both calls refused reads nothing', () => {
    setPaneExec(() => {
      throw new Error('refused');
    });
    expect(paneRead('%1', 8)).toBeNull();
  });

  test('a hung herdr is not asked twice', () => {
    const calls: string[][] = [];
    setPaneExec((args) => {
      calls.push(args);
      throw Object.assign(new Error('spawnSync herdr ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null });
    });
    expect(paneRead('%1', 8)).toBeNull();
    expect(calls.length).toBe(1);
  });
});

// reportDisplayAgent's process call is injectable the same way: these ask what the report
// carries, and which ttls are refused before the host is ever asked. The cap is herdr's own
// (invalid_metadata_ttl one above it, probed 2026-11-04).
describe('reportDisplayAgent', () => {
  afterEach(() => setCaptureExec(null));

  test('a ttl rides the report as --ttl-ms', () => {
    const calls: string[][] = [];
    setCaptureExec((args) => {
      calls.push(args);
      return '{}';
    });
    expect(reportDisplayAgent('fixture-pane-1', 'line two', 'fixture-session', 5000)).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['--session', 'fixture-session', 'pane', 'report-metadata', 'fixture-pane-1', '--source', 'team', '--display-agent', 'line two', '--ttl-ms', '5000']);
  });

  test('without a ttl no flag rides', () => {
    const calls: string[][] = [];
    setCaptureExec((args) => {
      calls.push(args);
      return '{}';
    });
    expect(reportDisplayAgent('fixture-pane-1', 'line two', 'fixture-session')).toBe(true);
    expect(calls[0]?.includes('--ttl-ms')).toBe(false);
  });

  test('a ttl above the host cap is refused before the call', () => {
    const calls: string[][] = [];
    setCaptureExec((args) => {
      calls.push(args);
      return '{}';
    });
    expect(reportDisplayAgent('fixture-pane-1', 'line two', 'fixture-session', SIDEBAR_TTL_CAP_MS + 1)).toBe(false);
    expect(calls.length).toBe(0);
  });

  test('a non-integer or non-positive ttl is refused the same way', () => {
    const calls: string[][] = [];
    setCaptureExec((args) => {
      calls.push(args);
      return '{}';
    });
    expect(reportDisplayAgent('fixture-pane-1', 'line two', 'fixture-session', 0)).toBe(false);
    expect(reportDisplayAgent('fixture-pane-1', 'line two', 'fixture-session', -5000)).toBe(false);
    expect(reportDisplayAgent('fixture-pane-1', 'line two', 'fixture-session', 1.5)).toBe(false);
    expect(calls.length).toBe(0);
  });
});

// The two host answers the sidebar edit leans on, read the way the probes captured them:
// `config check` answers `config: ok` and exit 0, or its issues text and exit 1 (the thrown
// stdout carries it); `server reload-config` answers `{"status":"applied","diagnostics":[]}`
// per session.
describe('hostConfigCheck', () => {
  afterEach(() => setCaptureExec(null));

  test('an accepted config reads ok', () => {
    setCaptureExec(() => 'config: ok\n');
    expect(hostConfigCheck()).toEqual({ ok: true, text: 'config: ok' });
  });

  test('a refused config names its issues from the thrown stdout', () => {
    setCaptureExec(() => {
      throw Object.assign(new Error('exit 1'), { stdout: 'config: issues found\nconfig parse error: unknown variant\n' });
    });
    const answer = hostConfigCheck();
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('issues found');
    expect(answer.text).toContain('unknown variant');
  });

  test('a check that answered nothing is a failure', () => {
    setCaptureExec(() => {
      throw new Error('boom');
    });
    expect(hostConfigCheck()).toEqual({ ok: false, text: 'boom' });
  });
});

describe('reloadConfig', () => {
  afterEach(() => setHerdrRun(null));

  test('applied with no diagnostics is the applied answer', () => {
    setHerdrRun(() => ({ status: 'applied', diagnostics: [] }));
    expect(reloadConfig('fixture-session')).toEqual({ applied: true, text: 'applied' });
  });

  test('diagnostics are a refusal that names them', () => {
    setHerdrRun(() => ({ status: 'applied', diagnostics: ['config parse error at line 2'] }));
    const answer = reloadConfig('fixture-session');
    expect(answer.applied).toBe(false);
    expect(answer.text).toContain('config parse error at line 2');
  });

  test('a throw or a non-answer is a refusal', () => {
    setHerdrRun(() => {
      throw new Error('server_not_running');
    });
    expect(reloadConfig('fixture-session')).toEqual({ applied: false, text: 'server_not_running' });
    setHerdrRun(() => null);
    expect(reloadConfig('fixture-session')).toEqual({ applied: false, text: 'reload-config did not answer' });
  });
});

describe('workspacePanes', () => {
  afterEach(() => setHerdrRun(null));

  test('valid entries for the requested workspace return string pane ids', () => {
    setHerdrRun(() => ({
      panes: [
        capturedPaneEntry(PANE_ONE, 'w1', 'term_65dd8274742df1'),
        capturedPaneEntry(PANE_TWO, 'w1', 'term_65dd8274742df2'),
      ],
      type: 'pane_list',
    }));
    expect(workspacePanes('w1')).toEqual([PANE_ONE, PANE_TWO]);
  });

  test('the right pane id under another workspace id reads null', () => {
    setHerdrRun(() => ({
      panes: [capturedPaneEntry(PANE_ONE, 'w2', 'term_65dd8274742df1')],
      type: 'pane_list',
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('entry under no workspace id reads null', () => {
    const { workspace_id: _omitted, ...withoutWorkspace } = capturedPaneEntry(PANE_ONE, 'w1', 'term_65dd8274742df1');
    setHerdrRun(() => ({
      panes: [withoutWorkspace],
      type: 'pane_list',
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('a non-object entry reads null', () => {
    setHerdrRun(() => ({
      panes: [PANE_ONE],
      type: 'pane_list',
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('a pane id that is not a string reads null', () => {
    setHerdrRun(() => ({
      panes: [{ ...capturedPaneEntry(PANE_ONE, 'w1', 'term_65dd8274742df1'), pane_id: 123 }],
      type: 'pane_list',
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('the right entry plus one malformed entry reads null', () => {
    const { workspace_id: _omitted, ...withoutWorkspace } = capturedPaneEntry(PANE_TWO, 'w1', 'term_65dd8274742df2');
    setHerdrRun(() => ({
      panes: [
        capturedPaneEntry(PANE_ONE, 'w1', 'term_65dd8274742df1'),
        withoutWorkspace,
      ],
      type: 'pane_list',
    }));
    expect(workspacePanes('w1')).toBeNull();
  });

  test('ownWatchPane finds the watch workspace pane from captured herdr 0.7.1 responses', async () => {
    const { ownWatchPane } = await import('../src/watch/pane.ts');
    const watchPane = ['w9', 'p1'].join(':');
    const watchWorkspace = {
      active_tab_id: ['w9', 't1'].join(':'),
      created_at: 1776221303,
      cwd: TEMP,
      focused: true,
      Focused: true,
      label: 'Watch · acme',
      pane_count: 1,
      tab_count: 1,
      workspace_id: 'w9',
    };
    const seatWorkspace = {
      active_tab_id: ['w1', 't1'].join(':'),
      created_at: 1776221300,
      cwd: TEMP,
      focused: false,
      Focused: false,
      label: 'seat',
      pane_count: 1,
      tab_count: 1,
      workspace_id: 'w1',
    };
    const processEntry = (paneId: string, shellPid: number, fgPid: number) => ({
      foreground_processes: [
        {
          argv0: 'bun',
          name: 'bun',
          pid: fgPid,
          ppid: shellPid,
          start_epoch: 1776221304,
          start_lstart: 'Wed Apr 15 04:48:24 2026',
        },
      ],
      pane_id: paneId,
      shell_name: 'zsh',
      shell_pid: shellPid,
      shell_start_epoch: 1776221303,
      shell_start_lstart: 'Wed Apr 15 04:48:23 2026',
      tty: 'ttys015',
    });
    setHerdrRun((args) => {
      if (args[0] === 'workspace' && args[1] === 'list') {
        return { type: 'workspace_list', workspaces: [watchWorkspace, seatWorkspace] };
      }
      if (args[0] === 'pane' && args[1] === 'list' && args[3] === 'w9') {
        return { panes: [capturedPaneEntry(watchPane, 'w9', 'term_65dd8274742df9')], type: 'pane_list' };
      }
      if (args[0] === 'pane' && args[1] === 'list') {
        return { panes: [capturedPaneEntry(PANE_ONE, 'w1', 'term_65dd8274742df1')], type: 'pane_list' };
      }
      if (args[0] === 'pane' && args[1] === 'process-info' && args[3] === watchPane) {
        return { process_info: processEntry(watchPane, process.ppid, process.pid), type: 'pane_process_info' };
      }
      return { process_info: processEntry(PANE_ONE, 1, 1), type: 'pane_process_info' };
    });
    expect(ownWatchPane('acme-web', process.pid)).toEqual({ pane: watchPane, workspace: 'w9' });
  });
});

describe('sessionStopped and isHerdrError', () => {
  const name = 'scratch-stop-032';

  test('the captured plain stop line for the asked name is a stop', () => {
    expect(sessionStopped('stopped session scratch-stop-032\n', name)).toBe(true);
    expect(sessionStopped('deleted session scratch-stop-032\n', name)).toBe(false);
    expect(sessionStopped('stopped session other\n', name)).toBe(false);
    expect(sessionStopped('{}', name)).toBe(false);
  });

  test('recognises both the captured herdr 0.7.1 error envelope and legacy type:error', () => {
    expect(isHerdrError({ error: { code: 'workspace_not_found', message: 'workspace w999 not found' }, id: 'cli:workspace:close' })).toBe(true);
    expect(isHerdrError({ type: 'error' })).toBe(true);
    expect(isHerdrError({ id: 'cli:workspace:close', result: { type: 'ok' } })).toBe(false);
    expect(isHerdrError(null)).toBe(false);
  });
});

describe('sessionCleared', () => {
  const name = 'scratch-clear-032';

  test('the captured plain delete line for the asked name is a clear', () => {
    expect(sessionCleared('deleted session scratch-clear-032\n', name)).toBe(true);
  });

  test('an empty object is not a clear', () => {
    expect(sessionCleared('{}', name)).toBe(false);
    expect(sessionCleared('{}\n', name)).toBe(false);
  });

  test('a result object is not a clear', () => {
    expect(sessionCleared('{"result":{}}', name)).toBe(false);
    expect(sessionCleared('{"result":{}}\n', name)).toBe(false);
  });

  test('an empty answer is not a clear', () => {
    expect(sessionCleared('', name)).toBe(false);
  });

  test('a stop line is not a clear', () => {
    expect(sessionCleared(`stopped session ${name}\n`, name)).toBe(false);
  });

  test('a delete of another name is not a clear', () => {
    expect(sessionCleared('deleted session other.dot\n', name)).toBe(false);
  });

  test('the right line plus a second line is not a clear', () => {
    expect(sessionCleared(`deleted session ${name}\nstill here\n`, name)).toBe(false);
  });
});

describe('captured Claude Code 2.1.289 stand-in helper', () => {
  test('CLAUDE_IDLE and claudeBox classify and read back as captured composer frames', async () => {
    const { CLAUDE_IDLE, claudeBox } = await import('./helpers.ts');
    const { readBox, readScreen } = await import('../src/watch/screen.ts');
    const { boxHoldsText } = await import('../src/launch/deliver.ts');
    expect(readScreen('claude-code', CLAUDE_IDLE)).toEqual({ kind: 'idle' });
    expect(readScreen('claude-code', claudeBox(''))).toEqual({ kind: 'idle' });
    expect(readScreen('claude-code', claudeBox('/exit'))).toEqual({ kind: 'unsent' });
    expect(boxHoldsText('claude-code', '/exit', claudeBox('/exit'))).toBe(true);
    expect(readBox('claude-code', claudeBox('line one\nline two'))).toEqual({
      first: 'line one',
      indent: 2,
      rows: ['  line two'],
    });
    expect(boxHoldsText('claude-code', 'line one line two', claudeBox('line one\nline two'))).toBe(true);
  });
});
