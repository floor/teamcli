import { describe, expect, test } from 'bun:test';
import { plainText } from '../src/launch/plain.ts';
import {
  buildActionSchemaSpec,
  buildCommandOutputSchema,
  collapseNotes,
  COMMAND_OUTPUT_SCHEMAS,
  contextLine,
  DIFFERENCE_WHO_VALUES,
  displayPath,
  ERROR_OUTPUT_SCHEMA,
  formatDeprecationWarning,
  formatHelpExits,
  formatTable,
  jsonEnvelope,
  jsonError,
  pluralCount,
  projectContextLine,
  renderActionSummary,
  renderDeprecationWarnings,
  renderDifference,
  renderDifferences,
  renderDryRunPlan,
  renderFinding,
  renderNotes,
  renderPlanStep,
  renderSummary,
  renderTable,
  SEVERITY_LABELS,
  SEVERITY_LEVELS,
  STATUS_OUTPUT_SCHEMA,
  summaryCounts,
  toJsonDifference,
  ttyStyle,
  whoFromCommand,
  whoOfDifference,
} from '../src/output/index.ts';
import {
  assertCleanHumanOutput,
  assertGoldenOutput,
  assertJsonErrorShape,
  assertMatchesOutputSchema,
  assertNoAnsi,
  stripAnsi,
  validateAgainstJsonSchema,
} from './helpers/output.ts';

describe('src/output/ — context line and tables', () => {
  test('contextLine and projectContextLine clean control bytes, unescape HTML entities idempotently, and format the header', () => {
    expect(contextLine('beacon\x1b[31m', 'beacon\nnext')).toBe('team beacon, session "beacon next"');
    expect(plainText('status &lt;seat&gt; &amp; &amp;lt;literal&amp;gt;')).toBe('status <seat> & &lt;literal&gt;');
    expect(projectContextLine({ name: 'Beacon', id: 'beacon', entity: 'acme', lead: null })).toBe(
      'project Beacon  beacon  entity acme  lead -',
    );
    expect(projectContextLine({ name: 'Beacon', id: 'beacon', entity: null, lead: 'lead-1' })).toBe(
      'project Beacon  beacon  lead lead-1',
    );
  });

  test('pluralCount and displayPath format real plurals and replace $HOME with ~ in human text', () => {
    expect(pluralCount(0, 'difference', 'differences', { zero: 'no' })).toBe('no differences');
    expect(pluralCount(1, 'difference')).toBe('1 difference');
    expect(pluralCount(3, 'difference')).toBe('3 differences');
    expect(pluralCount(0, 'seat')).toBe('0 seats');
    expect(pluralCount(1, 'seat')).toBe('1 seat');
    expect(pluralCount(4, 'seat')).toBe('4 seats');
    expect(pluralCount(1, 'task')).toBe('1 task');

    expect(displayPath('/Users/alice/.config/team/lobbies/acme', '/Users/alice')).toBe('~/.config/team/lobbies/acme');
    expect(displayPath('the lobby /Users/alice/.config/team/lobby is not in trust', '/Users/alice')).toBe(
      'the lobby ~/.config/team/lobby is not in trust',
    );
    expect(displayPath('/Users/alice_other/work', '/Users/alice')).toBe('/Users/alice_other/work');
  });

  test('renderTable prints uppercase headers, aligns on cleaned text, uses "-" for empty cells, and supports indent: ""', () => {
    const lines = renderTable({
      headers: ['seat', 'state', 'model', 'pane', 'reach'],
      rows: [
        ['claude-keeper', 'working', 'Claude Opus 5.5', 'w1:p1', 'socket'],
        ['codex-acme', 'missing', 'GPT Sol 6', null, 'typed'],
      ],
    });
    assertGoldenOutput(`${lines.join('\n')}\n`, [
      '  SEAT           STATE    MODEL            PANE   REACH',
      '  claude-keeper  working  Claude Opus 5.5  w1:p1  socket',
      '  codex-acme     missing  GPT Sol 6        -      typed',
    ]);

    const col0 = renderTable({
      headers: ['seat', 'state'],
      rows: [['claude-keeper', 'working']],
      indent: '',
    });
    expect(col0).toEqual(['SEAT           STATE', 'claude-keeper  working']);
  });

  test('TTY styling colours headers and cells only on a TTY when NO_COLOR is unset and json is false, and supports stream: stderr', () => {
    const plain = formatTable({
      headers: ['seat', 'state'],
      rows: [['claude-keeper', 'working'], ['codex-acme', 'missing']],
      style: ttyStyle({ stdoutIsTTY: false, env: {} }),
      styleCell: (padded, raw, _r, col, style) => (col === 1 ? style.styleState(padded || raw) : padded),
    });
    assertNoAnsi(plain);

    const noColor = formatTable({
      headers: ['seat', 'state'],
      rows: [['claude-keeper', 'working'], ['codex-acme', 'missing']],
      style: ttyStyle({ stdoutIsTTY: true, env: { NO_COLOR: '1' } }),
      styleCell: (padded, raw, _r, col, style) => (col === 1 ? style.styleState(padded || raw) : padded),
    });
    assertNoAnsi(noColor);
    expect(noColor).toBe(plain);

    const jsonStyle = ttyStyle({ stdoutIsTTY: true, env: {} }, { json: true });
    expect(jsonStyle.enabled).toBe(false);
    expect(jsonStyle.red('difference:')).toBe('difference:');

    const stderrStyle = ttyStyle({ stdoutIsTTY: false, stderrIsTTY: true, env: {} }, { stream: 'stderr' });
    expect(stderrStyle.enabled).toBe(true);
    expect(stderrStyle.yellow('warn')).toContain('\x1b[33m');

    const coloured = formatTable({
      headers: ['seat', 'state'],
      rows: [['claude-keeper', 'working'], ['codex-acme', 'missing']],
      style: ttyStyle({ stdoutIsTTY: true, env: {} }),
      styleCell: (padded, _raw, _r, col, style) => (col === 1 ? style.styleState(padded) : padded),
    });
    expect(coloured).toContain('\x1b[1m');
    expect(coloured).toContain('\x1b[32m');
    expect(coloured).toContain('\x1b[31m');
    expect(stripAnsi(coloured)).toBe(plain);
  });
});

describe('src/output/ — note collapsing, differences, severity, deprecation, actions, and help', () => {
  test('collapseNotes collapses exact duplicates by default and deduplicates (seat, reason) before grouping seats', () => {
    const raw = [
      'hold until 2026-10-04T00:00:00.000Z: freeze deploys',
      'codex-acme: version unread',
      'codex-acme: version unread',
      'deepseek-acme: version unread',
      'watch: pane w9:p1, pid 4242, last heartbeat 0s ago',
      'the herdr session "acme" is not running',
      'the herdr session "acme" is not running',
      'proc dev-server: builder-1 since 2026-10-17T10:00:00Z, pid 1234',
    ];
    expect(collapseNotes(raw)).toEqual([
      'hold until 2026-10-04T00:00:00.000Z: freeze deploys',
      'codex-acme: version unread (x2)',
      'deepseek-acme: version unread',
      'watch: pane w9:p1, pid 4242, last heartbeat 0s ago',
      'the herdr session "acme" is not running (x2)',
      'proc dev-server: builder-1 since 2026-10-17T10:00:00Z, pid 1234',
    ]);
    expect(collapseNotes(raw, { groupSeats: true })).toEqual([
      'hold until 2026-10-04T00:00:00.000Z: freeze deploys',
      'codex-acme, deepseek-acme: version unread (2 seats)',
      'watch: pane w9:p1, pid 4242, last heartbeat 0s ago',
      'the herdr session "acme" is not running (x2)',
      'proc dev-server: builder-1 since 2026-10-17T10:00:00Z, pid 1234',
    ]);
    expect(renderNotes(['codex-acme: version unread'])).toEqual(['note: codex-acme: version unread']);
    expect(renderNotes(['lobby at /Users/alice/.config/team/lobby'], { home: '/Users/alice' })).toEqual([
      'note: lobby at ~/.config/team/lobby',
    ]);
  });

  test('renderDifference, whoOfDifference, and renderSummary map to the closed 4-value vocabulary', () => {
    expect(DIFFERENCE_WHO_VALUES).toEqual(['the owner', "the team's lead", 'a grant holder', 'any seat']);
    expect(whoFromCommand('up')).toBe("the team's lead");
    expect(whoFromCommand('add')).toBe('the owner');
    expect(whoFromCommand('tempo')).toBe('the owner');
    expect(whoFromCommand('broker')).toBe('the owner');
    expect(whoFromCommand('restart')).toBe("the team's lead");
    expect(whoFromCommand('reload')).toBe("the team's lead");
    expect(whoFromCommand('status')).toBe('any seat');

    const diffs = [
      { what: 'claude-keeper is in the file and is not running', repair: 'team add claude-keeper' },
      { what: 'codex-acme needs restart', repair: 'team restart codex-acme' },
      { what: 'codex-acme rules file differs', repair: 'team reload codex-acme' },
      { what: 'codex-acme waits at a permission prompt', repair: 'the owner answers it in the pane', owner: true },
    ];
    expect(whoOfDifference(diffs[0]!)).toBe('the owner');
    expect(whoOfDifference(diffs[1]!)).toBe("the team's lead");
    expect(whoOfDifference(diffs[2]!)).toBe("the team's lead");
    expect(whoOfDifference(diffs[3]!)).toBe('the owner');

    expect(renderDifference(diffs[0]!)).toEqual([
      'difference: claude-keeper is in the file and is not running',
      '  repair: team add claude-keeper',
      '  who: the owner',
    ]);
    expect(renderDifferences([diffs[0]!, diffs[1]!])).toEqual([
      'difference: claude-keeper is in the file and is not running',
      '  repair: team add claude-keeper',
      '  who: the owner',
      'difference: codex-acme needs restart',
      '  repair: team restart codex-acme',
      "  who: the team's lead",
    ]);
    expect(summaryCounts([diffs[1]!, diffs[3]!])).toEqual({ differences: 2, owner_differences: 1 });
    expect(renderSummary([diffs[1]!, diffs[3]!])).toBe('2 differences, 1 for the owner');
    expect(renderSummary([diffs[1]!])).toBe('1 difference');
    expect(renderSummary([])).toBe('no differences');
  });

  // A chain runs its legs in order, so its who is the actor every leg admits — the narrowest.
  // An "or" alternative is another way into the repair, not a leg, and does not narrow it.
  test('a chained repair takes the actor every leg admits, and an alternative does not narrow it', () => {
    const at = (repair: string) => ({ what: 'a difference', repair });
    expect(whoOfDifference(at('team remove codex-acme --keep, then team add codex-acme'))).toBe('the owner');
    expect(whoOfDifference(at('restart the seat on the file\'s model (team remove codex-acme --keep, then team add codex-acme), or correct the file'))).toBe('the owner');
    expect(whoOfDifference(at('team remove codex-acme --abandon, then team up'))).toBe("the team's lead");
    // A verb phrase's own "or" is not an alternative branch: the chain is still `team up`'s.
    expect(whoOfDifference(at('clear or send it in the pane, then team up (it resumes the launch)'))).toBe("the team's lead");
    // The branch after ", or" is not a leg: its owner-only remove-then-add does not narrow this
    // chain. The chain keeps prose "the team file" (the map's lead fallback) beside `team
    // register`, so the line reads as it did before the chain rule.
    expect(whoOfDifference(at('update the team file\'s model, then team register codex-acme, or relaunch on the recorded model (team remove codex-acme --keep, then team add codex-acme)'))).toBe("the team's lead");
    // The closing count speaks from the same who the row prints.
    expect(renderSummary([at('team remove codex-acme --keep, then team add codex-acme')])).toBe('1 difference, 1 for the owner');
  });

  test('severity vocabulary, deprecation helper, action helpers, and help exits helper', () => {
    expect(SEVERITY_LEVELS).toEqual(['ok', 'warn', 'miss', 'note']);
    expect(SEVERITY_LABELS).toEqual({
      ok: 'ok  ',
      warn: 'warn',
      miss: 'MISS',
      note: 'note',
    });
    expect(renderFinding({ level: 'ok', text: 'herdr 0.7.1' })).toBe('ok    herdr 0.7.1');
    expect(renderFinding({ level: 'note', text: 'session beacon is running' })).toBe('note  session beacon is running');
    expect(renderFinding({ level: 'warn', text: 'older herdr' })).toBe('warn  older herdr');
    expect(renderFinding({ level: 'miss', text: 'install herdr' })).toBe('MISS  install herdr');
    assertCleanHumanOutput('note  session beacon is running\nno differences\n', { home: '/Users/alice' });

    expect(formatDeprecationWarning({ line: 3, message: '`coordinator:` is now `leads: true`' })).toBe(
      'warning: the file, line 3: `coordinator:` is now `leads: true`',
    );
    expect(renderDeprecationWarnings([{ line: 3, message: 'legacy field' }])).toEqual([
      'warning: the file, line 3: legacy field',
    ]);

    expect(renderPlanStep({ prefix: '+', step: 'create', detail: 'herdr create acme', seat: 'claude-keeper' })).toBe(
      '+ create: claude-keeper: herdr create acme',
    );
    expect(
      renderDryRunPlan('team up (dry run): session "acme"', [
        { prefix: '+', step: 'worktree', detail: '/tmp/wt' },
        { prefix: 'skip', step: 'session', detail: 'already running' },
      ]),
    ).toEqual([
      'team up (dry run): session "acme"',
      '+ worktree: /tmp/wt',
      '  skip session: already running',
      'dry run: nothing was run',
    ]);
    expect(renderActionSummary({ command: 'up', summary: 'started 2 seats in session "acme"' })).toBe(
      'team up: started 2 seats in session "acme"',
    );
    expect(formatHelpExits([{ code: 0, when: 'when clean' }, { code: 1, when: 'on difference' }])).toBe(
      'Exits 0 when clean, 1 on difference.',
    );
  });
});

describe('src/output/ — JSON envelope, error writer, and schema validation', () => {
  test('jsonEnvelope prevents payload schema override and validates against STATUS_OUTPUT_SCHEMA', () => {
    const doc = jsonEnvelope('team.status', {
      format: 1 as const,
      project: 'beacon',
      session: 'beacon',
      rows: [
        {
          name: 'claude-keeper',
          state: 'working',
          model: 'Claude Opus 5.5',
          pane: 'w1:p1',
        },
      ],
      notes: [],
      differences: [
        toJsonDifference({
          what: 'claude-beacon is in the file and is not running',
          repair: 'team add claude-beacon',
        }),
      ],
      summary: { differences: 1, owner_differences: 0 },
      notice: null,
      ...({ schema: { name: 'spoofed', version: 99 } } as Record<string, unknown>),
    });
    expect(doc.schema).toEqual({ name: 'team.status', version: 1 });
    const parsed = assertMatchesOutputSchema(JSON.stringify(doc), STATUS_OUTPUT_SCHEMA);
    expect(parsed).toEqual(doc);
  });

  test('buildActionSchemaSpec validates an action envelope', () => {
    const spec = buildActionSchemaSpec({
      name: 'team.park',
      fileName: 'park.schema.json',
      title: 'team park JSON output',
      statuses: ['parked', 'dry-run'],
      required: ['seat'],
      properties: {
        seat: { type: 'string' },
      },
    });
    const doc = jsonEnvelope('team.park', {
      format: 1 as const,
      dry_run: true,
      status: 'dry-run',
      action_summary: 'dry run: nothing was run',
      plan: [{ prefix: '+' as const, step: 'park', detail: 'record parked', seat: 'codex-acme' }],
      seat: 'codex-acme',
    });
    const parsed = assertMatchesOutputSchema(JSON.stringify(doc), spec);
    expect(parsed).toEqual(doc);
  });

  test('jsonError and ERROR_OUTPUT_SCHEMA validate an error document and optional permission rule id', () => {
    const raw = JSON.stringify(
      jsonError('add.caller', 'only the owner runs this', 'the owner runs team add', 1, 'owner-only'),
    );
    const checked = assertJsonErrorShape(raw, {
      id: 'add.caller',
      messageContains: 'only the owner runs this',
      repair: 'the owner runs team add',
    });
    expect(checked.error.id).toBe('add.caller');
    expect((checked.error as { rule?: string }).rule).toBe('owner-only');
    expect(() => assertMatchesOutputSchema(raw, ERROR_OUTPUT_SCHEMA)).not.toThrow();
  });

  test('walks COMMAND_OUTPUT_SCHEMAS and validates a real payload for every command (and every oneOf branch)', () => {
    const samplePayloads: Record<string, unknown[]> = {
      'team.error': [
        jsonError('policy.refused', 'refused', 'team policy unset team dev-mode', 1, 'owner-only'),
      ],
      'team.about': [
        jsonEnvelope('team.about', {
          format: 1 as const,
          version: '0.5.0-rc.4',
          description: 'Declarative multi-agent teams',
          licence: 'MIT',
          docs: 'https://github.com/floor/teamcli',
          must_not_pretend: [
            {
              text: 'The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.',
              ref: 'Kernel §11, §12, §14',
            },
          ],
        }),
      ],
      'team.status': [
        jsonEnvelope('team.status', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          rows: [{ name: 'lead', state: 'working', model: 'Claude Opus 5.5', pane: 'w1:p1' }],
          notes: [],
          differences: [],
          summary: { differences: 0, owner_differences: 0 },
          notice: null,
        }),
        jsonEnvelope('team.status.project', {
          format: 1 as const,
          project: { id: 'beacon', name: 'beacon', entity: 'floor', lead: null },
          teams: [{ name: 'beacon', session: 'beacon', lifecycle: 'running', seats: 2 }],
        }),
      ],
      'team.seats': [
        jsonEnvelope('team.seats', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          seats: [
            {
              name: 'lead',
              id: 'seat_000000000001',
              role: 'coordinator',
              cli: 'claude-code',
              model: 'Claude Opus 5.5',
              effort: null,
              status: 'working',
              state: 'working',
              state_source: 'cli',
              last_active: null,
              pane: 'w1:p1',
              launch_line: 'claude --model claude-opus-5-5',
            },
          ],
        }),
      ],
      'team.projects': [
        jsonEnvelope('team.projects', {
          format: 1 as const,
          projects: [
            {
              id: 'beacon',
              name: 'beacon',
              entity: 'floor',
              lead: null,
              teams: ['tm_000000000001'],
              provenance: {
                registered_by: 'owner',
                registered_at: '2026-10-17T12:00:00Z',
                updated_at: '2026-10-17T12:00:00Z',
              },
            },
          ],
        }),
      ],
      'team.doctor': [
        jsonEnvelope('team.doctor', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          findings: [{ level: 'ok', text: 'herdr 0.7.1', blocks_launch: false }],
          summary: { missing: 0, warnings: 0, blockers: 0 },
        }),
      ],
      'team.check': [
        jsonEnvelope('team.check', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          key_isolation: 'key isolation: enforced against team panes (key file still readable by same-user processes)',
          warnings: [],
          repaired: [],
          notes: [],
          differences: [],
          summary: { differences: 0, owner_differences: 0 },
        }),
      ],
      'team.client.keygen': [
        jsonEnvelope('team.client.keygen', {
          format: 1 as const,
          status: 'created' as const,
          key_path: '/home/u/.config/team-client/grok-bot/client.key',
          public_key_path: '/home/u/.config/team-client/grok-bot/client.pub',
          key_dir: '/home/u/.config/team-client/grok-bot',
          public_key: 'a'.repeat(64),
          key_id: '0123456789ab',
          key_isolation: 'key isolation: enforced against team panes (key file still readable by same-user processes)',
        }),
      ],
      'team.list': [
        jsonEnvelope('team.list', {
          format: 1 as const,
          rows: [
            {
              team: 'beacon',
              project: '/tmp/beacon',
              status: 'running',
              seats: '2/2',
              activity: 'working',
              note: '',
            },
          ],
        }),
      ],
      'team.grant': [
        jsonEnvelope('team.grant', {
          format: 1 as const,
          dry_run: false,
          status: 'updated',
          action_summary: 'granted up to lead',
          project: 'beacon',
          session: 'beacon',
          target: 'lead',
        }),
      ],
      'team.delegate': [
        jsonEnvelope('team.delegate', {
          format: 1 as const,
          dry_run: false,
          status: 'updated',
          action_summary: 'delegated status to w1:p1',
          project: 'beacon',
          session: 'beacon',
          target: 'w1:p1',
          commands: ['status'],
        }),
      ],
      'team.revoke': [
        jsonEnvelope('team.revoke', {
          format: 1 as const,
          dry_run: false,
          status: 'updated',
          action_summary: 'revoked lead',
          project: 'beacon',
          session: 'beacon',
          target: 'lead',
        }),
      ],
      'team.hold': [
        jsonEnvelope('team.hold', {
          format: 1 as const,
          dry_run: false,
          status: 'placed',
          action_summary: 'hold: freeze deploys',
          project: 'beacon',
          session: 'beacon',
          target: 'beacon',
          value: 'freeze deploys',
        }),
      ],
      'team.pause': [
        jsonEnvelope('team.pause', {
          format: 1 as const,
          dry_run: false,
          status: 'paused',
          action_summary: 'paused since 2026-10-04T09:00:00.000Z by owner',
          project: 'beacon',
          session: 'beacon',
          target: 'team',
          value: null,
          pause: { by: 'owner', at: '2026-10-04T09:00:00.000Z', stops: [{ seat: 'lead' }] },
        }),
      ],
      'team.resume': [
        jsonEnvelope('team.resume', {
          format: 1 as const,
          dry_run: false,
          status: 'resumed',
          action_summary: 'resumed beacon (paused since 2026-10-04T09:00:00.000Z by owner)',
          project: 'beacon',
          session: 'beacon',
          target: 'team',
          value: null,
          resumed: { by: 'owner', at: '2026-10-04T09:00:00.000Z', stops: [{ seat: 'lead' }] },
        }),
      ],
      'team.sessions': [
        jsonEnvelope('team.sessions', {
          format: 1 as const,
          by: null,
          seat: null,
          sessions: [
            {
              id: 'ses_0123456789ab',
              seat: 'worker',
              team: 'beacon',
              project: 'beacon',
              cli: 'claude',
              lab: 'anthropic',
              account: 'max',
              herdr_session: 'beacon',
              started: '2026-10-17T10:00:00Z',
              ended: '2026-10-17T12:00:00Z',
              reason: 'swap',
            },
          ],
        }),
        jsonEnvelope('team.sessions', {
          format: 1 as const,
          by: 'team' as const,
          seat: 'claude-keeper',
          sessions: [
            {
              id: 'ses_aaaaaaaaaaaa',
              seat: 'claude-keeper',
              team: 'beacon',
              project: 'beacon',
              cli: 'claude-code',
              lab: 'anthropic',
              account: 'anthropic',
              herdr_session: 'beacon',
              started: '2026-10-19T13:58:00Z',
              ended: '2026-10-19T14:03:00Z',
              reason: 'restart' as const,
            },
          ],
        }),
      ],
      'team.raise': [
        jsonEnvelope('team.raise', {
          format: 1 as const,
          dry_run: false,
          status: 'raised',
          action_summary: 'raise: release.ready delivered to the owner at once',
          project: 'beacon',
          session: 'beacon',
          kind: 'release.ready',
          text: 'v0.5.1 is ready for the owner',
          route: 'owner',
          at: '2026-10-17T12:00:00.000Z',
          record: 'evt-7-0a1b2c3d4e5f',
          count: 1,
        }),
        jsonEnvelope('team.raise', {
          format: 1 as const,
          dry_run: true,
          status: 'dry-run',
          action_summary: 'raise: would merge release.ready into the owner\'s record (×2)',
          project: 'beacon',
          session: 'beacon',
          kind: 'release.ready',
          text: 'v0.5.1 is ready for the owner',
          route: 'owner',
          at: '2026-10-17T12:05:00.000Z',
          record: null,
          count: 2,
        }),
      ],
      'team.lock': [
        jsonEnvelope('team.lock', {
          format: 1 as const,
          dry_run: false,
          status: 'taken',
          action_summary: 'locked deploy',
          project: 'beacon',
          target: 'deploy',
          value: 'deploy',
          holder: { team: 'beacon', run: '1', by: 'lead', at: '2026-10-17T12:00:00Z' },
        }),
      ],
      'team.unlock': [
        jsonEnvelope('team.unlock', {
          format: 1 as const,
          dry_run: false,
          status: 'released',
          action_summary: 'unlocked deploy',
          project: 'beacon',
          target: 'deploy',
          value: null,
        }),
      ],
      'team.release': [
        jsonEnvelope('team.release', {
          format: 1 as const,
          package: '@floor/teamcli',
          version: '0.5.0',
          checks: {
            npm: { status: 'pass', detail: 'published' },
            tag: { status: 'pass', detail: 'v0.5.0' },
            github: { status: 'pass', detail: 'release exists' },
            changelog: { status: 'pass', detail: 'entry present' },
          },
          summary: { checks: 4, missing: 0, unknown: 0 },
        }),
      ],
      'team.policy': [
        jsonEnvelope('team.policy', {
          format: 1 as const,
          status: 'ok' as const,
          project: 'beacon',
          session: 'beacon',
          entity: 'floor',
          in_project: null,
          seat: null,
          dev_mode_governed: false,
          policies: [
            {
              name: 'dev-mode',
              value: 'off',
              level: 'default',
              setter: null,
              date: null,
              expiry: null,
              kind: 'enforced',
              set: true,
            },
          ],
        }),
        jsonEnvelope('team.policy', {
          format: 1 as const,
          dry_run: false,
          status: 'updated',
          action_summary: 'policy: set dev-mode=on at team (tm_000000000001)',
          project: 'beacon',
          session: 'beacon',
          level: 'team',
          target: 'tm_000000000001',
          policy: 'dev-mode',
          value: 'on',
          expiry: null,
          kind: 'enforced',
        }),
      ],
      'team.add': [
        jsonEnvelope('team.add', {
          format: 1 as const,
          dry_run: false,
          status: 'ready',
          action_summary: 'added worker in pane w1:p1',
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          pane: 'w1:p1',
          notes: [],
        }),
      ],
      'team.answer': [
        jsonEnvelope('team.answer', {
          format: 1 as const,
          dry_run: false,
          status: 'answered',
          action_summary: 'answered the trust dialog for worker',
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          pane: 'w1:p1',
          dialog: 'trust' as const,
          state: 'ready' as const,
          folder: '/work/beacon',
        }),
      ],
      'team.ask-show': [
        jsonEnvelope('team.ask-show', {
          format: 1 as const,
          request_id: 'req-1',
          question: 'ship the release candidate?',
          expires_at: '2026-10-17T12:00:00Z',
          verified: true as const,
        }),
      ],
      'team.commits': [
        jsonEnvelope('team.commits', {
          format: 1 as const,
          ref: 'main',
          since: null,
          commits: [],
          skipped: 0,
          pull_request: null,
          differences: [],
          notes: [],
          summary: { commits: 0, refused: 0, exempt: 0, skipped: 0, ok: true },
          notice: null,
        }),
      ],
      // The rollout plan and its apply outcome: one canonical row for a delivery the plan would
      // write, with the counts its summary carries. Every action word the schema allows is
      // exercised by the command's own scenes; this payload proves the published shape.
      'team.brief': [
        jsonEnvelope('team.brief', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          apply: false,
          seats: [
            {
              seat: 'worker',
              action: 'deliver',
              hash12: '4b273912a6c9',
              id: '0d9c1f0e-5a2b-4c3d-8e4f-1a2b3c4d5e6f',
              from: null,
              reason: null,
              current: false,
            },
          ],
          counts: { current: 0, deliver: 1, recover: 0, not_running: 0, human: 0, stale_listener: 0, failed: 0 },
        }),
      ],
      'team.down': [
        jsonEnvelope('team.down', {
          format: 1 as const,
          dry_run: false,
          status: 'stopped',
          action_summary: 'stopped worker',
          project: 'beacon',
          session: 'beacon',
          seats: ['worker'],
          notes: [],
        }),
      ],
      'team.drops': [
        jsonEnvelope('team.drops', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          drops: [{ from: 'the owner', received: '2026-10-17T12:00:00.000Z', path: '/work/beacon/.agents/send-drops/beacon/worker/0a5b7c1d-8e2f-4a6b-9c3d-1e2f3a4b5c6d' }],
          counts: { drops: 1 },
        }),
      ],
      'team.ack': [
        jsonEnvelope('team.ack', {
          format: 1 as const,
          status: 'read',
          action_summary: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d: read',
          project: 'beacon',
          session: 'beacon',
          record: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d',
          to: 'worker',
          thread: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d',
          written: false,
          at: '2026-10-18T15:30:00.000Z',
        }),
      ],
      'team.reply': [
        jsonEnvelope('team.reply', {
          format: 1 as const,
          status: 'replied',
          action_summary: 'worker: replied',
          project: 'beacon',
          session: 'beacon',
          record: '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          thread: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d',
          in_reply_to: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d',
          to: 'worker',
          rule: 'the owner',
          reply: 'the answer',
          at: '2026-10-18T15:30:00.000Z',
        }),
        jsonEnvelope('team.reply', {
          format: 1 as const,
          status: 'closed',
          action_summary: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d: closed',
          project: 'beacon',
          session: 'beacon',
          record: null,
          thread: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d',
          in_reply_to: '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d',
          to: null,
          rule: null,
          reply: null,
          at: '2026-10-18T15:30:00.000Z',
        }),
      ],
      'team.feed': [
        jsonEnvelope('team.feed', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          events: [{
            ts: '2026-10-17T12:00:00Z',
            from: 'lead',
            to: 'worker',
            body: 'status?',
            id: 'm1',
            outcome: 'delivered',
            status: 'delivered',
            thread: 'm1',
          }],
        }),
      ],
      'team.init': [
        jsonEnvelope('team.init', {
          format: 1 as const,
          dry_run: false,
          status: 'wrote',
          action_summary: 'wrote .agents/team.yaml',
          project: 'beacon',
          session: 'beacon',
          file: '.agents/team.yaml',
          restored: false,
          notes: [],
        }),
      ],
      'team.issues': [
        jsonEnvelope('team.issues', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          issues: [{ id: 'issue-1', title: 'merge the contract branches', state: 'open', assignee: 'lead' }],
        }),
      ],
      'team.mcp': [
        jsonEnvelope('team.mcp', {
          format: 1 as const,
          lobby_dir: '/work/lobby',
          helper: { root: '/work/lobby', present: true, rows: [] },
          bridges: [],
          guards: [],
          front: { origin: 'https://lobby.example', mcp_status: 200, connector_status: 200, tls_valid_to: null, tls_authorized: true },
          state: 'up',
        }),
        jsonEnvelope('team.mcp', {
          format: 1 as const,
          lobby_dir: '/work/lobby',
          findings: [{ level: 'ok', text: 'the helper is present', fix: null }],
          missing: 0,
          warnings: 0,
        }),
      ],
      'team.messages': [
        jsonEnvelope('team.messages', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          rows: [],
          notes: [],
          differences: [],
          summary: { differences: 0, owner_differences: 0 },
          counts: { messages: 0, shown: 0, refused: 0 },
        }),
      ],
      'team.messages.client': [
        jsonEnvelope('team.messages.client', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          client: 'grok-bot',
          rows: [
            {
              id: 'm-1',
              from: 'lead',
              to: 'grok-bot',
              sent: '2026-10-19T14:03:00Z',
              sent_display: '0s ago',
              status: 'shown' as const,
              body: 'the relay is ready',
            },
            {
              id: 'm-2',
              from: 'lead',
              to: 'grok-bot',
              sent: '2026-10-19T14:03:00Z',
              sent_display: '0s ago',
              status: 'refused' as const,
            },
          ],
          notes: [],
          differences: [],
          summary: { differences: 0, owner_differences: 0 },
          counts: { messages: 2, shown: 1, refused: 1 },
          key_isolation: 'key isolation: enforced against team panes (key file still readable by same-user processes)',
        }),
      ],
      'team.next': [
        jsonEnvelope('team.next', {
          format: 1 as const,
          dry_run: true,
          status: 'none',
          action_summary: 'next: nothing to claim',
          project: 'beacon',
          session: 'beacon',
          action: 'none',
          task: null,
        }),
      ],
      'team.plan': [
        jsonEnvelope('team.plan', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          tasks: [{ step: 1, state: 'open', owner: 'lead', id: 'task-1', title: 'merge the contract branches' }],
        }),
      ],
      'team.queue': [
        jsonEnvelope('team.queue', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          source: 'local' as const,
          path: '.agents/queue.yaml',
          status: 'added' as const,
          task: { id: 'q1', title: 'a queued task', assignee: 'worker', priority: 2 },
          tasks: [{ id: 'q1', title: 'a queued task', assignee: 'worker', priority: 2 }],
        }),
        jsonEnvelope('team.queue', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          source: 'local' as const,
          path: '.agents/queue.yaml',
          tasks: [],
        }),
      ],
      'team.green-slice': [
        jsonEnvelope('team.green-slice', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          action: 'ready' as const,
          status: 'recorded' as const,
          event: {
            kind: 'ready' as const,
            task: 'q1',
            seat: 'worker',
            commit: 'abc1234',
            version: '0.5.3',
            at: '2026-10-20T10:00:00.000Z',
          },
        }),
        jsonEnvelope('team.green-slice', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          action: 'install' as const,
          status: 'held' as const,
          event: {
            kind: 'install' as const,
            task: 'q1',
            commit: 'abc1234',
            version: '0.5.3',
            installedBy: 'owner',
            at: '2026-10-20T10:01:00.000Z',
          },
        }),
      ],
      'team.pr': [
        jsonEnvelope('team.pr', {
          format: 1 as const,
          differences: [],
          notes: [],
          summary: { differences: 0, owner_differences: 0 },
          notice: null,
        }),
      ],
      'team.proc': [
        jsonEnvelope('team.proc', {
          format: 1 as const,
          dry_run: false,
          status: 'added',
          action_summary: 'proc: added deploy',
          project: 'beacon',
          session: 'beacon',
          target: 'deploy',
          value: null,
        }),
        jsonEnvelope('team.proc', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          notice: null,
          procs: [{ name: 'deploy', by: 'lead', since: '2026-10-17T12:00:00Z', pid: null, note: null }],
          summary: { processes: 1 },
        }),
      ],
      'team.register': [
        jsonEnvelope('team.register', {
          format: 1 as const,
          dry_run: false,
          status: 'ready',
          action_summary: 'registered worker in pane w1:p1',
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          pane: 'w1:p1',
          notes: [],
        }),
      ],
      'team.reload': [
        jsonEnvelope('team.reload', {
          format: 1 as const,
          dry_run: false,
          status: 'reloaded',
          action_summary: 'reloaded worker',
          seat: 'worker',
          pane: 'w1:p1',
        }),
      ],
      'team.remove': [
        jsonEnvelope('team.remove', {
          format: 1 as const,
          dry_run: false,
          status: 'removed',
          action_summary: 'removed worker',
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          notes: [],
        }),
      ],
      'team.restart': [
        jsonEnvelope('team.restart', {
          format: 1 as const,
          dry_run: false,
          status: 'ready',
          action_summary: 'restarted worker',
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          pane: 'w1:p1',
          notes: [],
        }),
      ],
      'team.route': [
        jsonEnvelope('team.route', {
          format: 1 as const,
          dry_run: false,
          status: 'routed',
          action_summary: 'routed worker to w1:p1',
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          agent: 'worker',
          recipient_session: 'beacon',
          cli: 'claude',
          pane: 'w1:p1',
          address: null,
          socket_state: 'live',
          native: true,
          rule: 'a seat addresses its team',
        }),
      ],
      'team.send': [
        jsonEnvelope('team.send', {
          format: 1 as const,
          dry_run: false,
          status: 'delivered',
          action_summary: 'sent to worker',
          project: 'beacon',
          session: 'beacon',
          seat: 'worker',
          ids: { sent: 'm1', reply: 'm2' },
          reply: '',
          address: null,
        }),
        jsonEnvelope('team.send.list', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          seats: [{ name: 'worker', nickname: null, cli: 'claude', role: 'builder', project: 'beacon', reach: 'socket', stopped: false }],
          summary: '1 seat',
        }),
      ],
      // A queued swap as `team swap queue` writes it: the record the watch carries out at the
      // seat's boundary, its donor recipe and the rule that chose it.
      'team.swap': [
        jsonEnvelope('team.swap', {
          format: 1 as const,
          dry_run: false,
          status: 'queued',
          action_summary: 'swap: worker queued',
          project: 'beacon',
          session: 'beacon',
          entity: 'floor',
          seat: 'worker',
          swap: {
            from: { cli: 'claude-code', vendor: 'openai', model: 'gpt-5', version: '1.0', display: 'gpt-5 1.0' },
            to: {
              cli: 'claude-code',
              vendor: 'anthropic',
              model: 'Claude Opus',
              version: '5.5',
              display: 'Claude Opus 5.5',
              launch: 'claude --model claude-opus-5-5',
            },
            reason: 'model-rule',
            queuedAt: '2026-10-19T09:00:00.000Z',
            deadline: '2026-10-19T09:30:00.000Z',
            waitFor: "the seat's boundary (quiet, no turn, no dialog, no lease, no work drop)",
            rule: '*=!openai',
          },
          donor: { team: 'beacon', root: '/work/beacon', seat: 'lead' },
          notice: null,
        }),
      ],
      'team.tempo': [
        jsonEnvelope('team.tempo', {
          format: 1 as const,
          dry_run: false,
          status: 'set',
          action_summary: 'tempo: normal',
          project: 'beacon',
          session: 'beacon',
          value: 'normal',
        }),
      ],
      'team.up': [
        jsonEnvelope('team.up', {
          format: 1 as const,
          dry_run: false,
          status: 'ready',
          action_summary: 'brought worker up',
          project: 'beacon',
          session: 'beacon',
          seats: ['worker'],
          notes: [],
        }),
      ],
      'team.usage': [
        jsonEnvelope('team.usage', {
          format: 1 as const,
          at: '2026-10-17T12:00:00.000Z',
          view: 'restricted' as const,
          mine: 'beacon',
          counts: { teams: 1, labs: 2, accounts: 2 },
          labs: [
            {
              lab: 'anthropic',
              accounts: [{
                account: 'anthropic',
                kind: 'subscription' as const,
                readable: true,
                teams: [],
                machine: { window: 'session' as const, left: 80, used: 20, resetsIn: '2h', source: 'status_line' },
              }],
            },
            { lab: 'deepseek', accounts: [], seats: 11 },
          ],
          quota: {
            format: 1,
            accountsFile: '~/.config/team/accounts.yaml',
            labs: [],
            advice: 'no readings yet: no seat status line and no CLI usage command has answered',
          },
          unknown: [],
          notes: [{ scope: 'team', why: 'its file could not be read' }],
          teams: [{
            team: 'beacon',
            seats: [{ seat: 'claude-keeper', cli: 'claude-code', account: 'anthropic' }],
          }],
        }),
      ],
      'team.settings': [
        jsonEnvelope('team.settings', {
          format: 1 as const,
          project: 'beacon',
          seat: 'claude-keeper',
          settings: [
            { key: 'model', value: 'Claude Opus 5.5', source: 'team file', applies: 'restart-resume' },
            { key: 'effort', value: null, source: 'none', applies: 'restart-resume' },
            { key: 'delivery_order', value: ['mcp-inbox', 'drop', 'typed'], source: 'default', applies: 'at-once' },
            { key: 'human', value: false, source: 'default', applies: 'at-once' },
          ],
        }),
      ],
      'team.settings-change': [
        jsonEnvelope('team.settings-change', {
          format: 1 as const,
          dry_run: false,
          status: 'updated' as const,
          action_summary: 'settings: set nickname=Atlas at seat (claude-keeper)',
          project: 'beacon',
          session: 'beacon',
          level: 'seat' as const,
          target: 'agt_000000000000',
          seat: 'claude-keeper',
          settings: [
            { key: 'nickname', value: 'Atlas', old: null, applies: 'at-once' },
          ],
        }),
      ],
      'team.config-keys': [
        jsonEnvelope('team.config-keys', {
          format: 1 as const,
          level: null,
          keys: [
            {
              key: 'model',
              levels: ['seat'],
              type: 'model',
              allowed: "a model the seat's profile and the allowed-models policy accept",
              default: null,
              governed_by: 'allowed-models',
              applies: 'restart-resume',
            },
            {
              key: 'delivery_order',
              levels: ['seat'],
              type: 'order',
              allowed: 'delivery legs, tighten only',
              default: ['mcp-inbox', 'drop', 'typed'],
              governed_by: 'delivery-order',
              applies: 'at-once',
            },
          ],
        }),
      ],
      'team.seat': [
        jsonEnvelope('team.seat', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          seat: 'claude-keeper',
          settings: [
            { key: 'model', value: 'Claude Opus 5.5', source: 'team file', applies: 'restart-resume' },
            { key: 'effort', value: null, source: 'none', applies: 'restart-resume' },
            { key: 'delivery_order', value: ['mcp-inbox', 'drop', 'typed'], source: 'default', applies: 'at-once' },
            { key: 'human', value: false, source: 'default', applies: 'at-once' },
          ],
          status: {
            name: 'claude-keeper',
            nickname: null,
            id: null,
            role: 'worker',
            cli: 'claude-code',
            model: 'Claude Opus 5.5',
            effort: null,
            status: 'idle',
            state: 'idle',
            state_source: 'cli-hook',
            last_active: '2026-10-19T14:03:00Z',
            pane: 'w1:p1',
            launch_line: 'claude --model claude-opus-5-5',
          },
          turn: { state: 'idle', since: '2026-10-19T14:03:00Z' },
          conversation: {
            id: 'ses_aaaaaaaaaaaa',
            cli_session: 'cli-1',
            resumable: true,
            started: '2026-10-19T13:58:00Z',
            ended: '2026-10-19T14:03:00Z',
            reason: 'restart',
          },
          cost: { amount: 1.2, currency: 'USD', source: 'measured' },
          tokens: { in: 100, out: 20, source: 'measured' },
        }),
      ],
      'team.worktree': [
        jsonEnvelope('team.worktree', {
          format: 1 as const,
          dry_run: false,
          status: 'created',
          action_summary: 'created a worktree for merge-contract',
          project: 'beacon',
          session: 'beacon',
          action: 'new',
          task: 'merge-contract',
          branch: 'feat/merge-contract',
          path: '/work/worktrees/beacon/merge-contract',
        }),
        jsonEnvelope('team.worktree', {
          format: 1 as const,
          project: 'beacon',
          session: 'beacon',
          notice: null,
          worktrees: [{
            task: 'merge-contract',
            branch: 'feat/merge-contract',
            path: '/work/worktrees/beacon/merge-contract',
            session: 'beacon',
            seat: 'worker',
            exists: true,
          }],
          notes: [],
          summary: { worktrees: 1 },
        }),
      ],
      'team.workflow': [
        jsonEnvelope('team.workflow', {
          format: 1 as const,
          ok: true,
          path: 'workflow.yaml',
          definition: {
            workflow: 'build-review-merge',
            schemaVersion: 1 as const,
            digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          findings: [],
          summary: { refusals: 0, notes: 0 },
        }),
        {
          format: 1 as const,
          kind: 'workflow-run-dry' as const,
          authoritative: false as const,
          notice: 'dry run — no record is written',
          definition: {
            workflow: 'build-review-merge',
            schemaVersion: 1 as const,
            digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          run: 'run-0123456789abcdef',
          target: 'floor/teamcli#1',
          artifact: { kind: 'none' as const },
          inputs: {},
          settings: {},
          initial: 'draft',
          start: { state: 'draft', activation: 1 as const, effects: [] },
          steps: [],
          outcome: { kind: 'script-exhausted' as const },
        },
        jsonEnvelope('team.workflow', {
          format: 1 as const,
          kind: 'workflow-replay' as const,
          authoritative: false as const,
          notice: 'dry run — no record is written',
          ok: true,
          definition: {
            workflow: 'build-review-merge',
            schemaVersion: 1 as const,
            digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
          run: 'run-0123456789abcdef',
          stepsReplayed: 0,
          finalState: 'draft',
          revision: 0,
          activation: 1,
          blocked: null,
        }),
      ],
    };

    for (const spec of COMMAND_OUTPUT_SCHEMAS) {
      const payloads = samplePayloads[spec.name];
      expect(payloads, `missing sample payload for ${spec.name}`).toBeDefined();
      const schema = buildCommandOutputSchema(spec);
      for (const payload of payloads ?? []) {
        expect(validateAgainstJsonSchema(payload, schema)).toEqual([]);
      }
      if (spec.oneOf) {
        expect(payloads?.length).toBeGreaterThanOrEqual(spec.oneOf.length);
        spec.oneOf.forEach((branch, index) => {
          expect(validateAgainstJsonSchema(payloads?.[index], branch)).toEqual([]);
        });
      }
    }
  });
});
