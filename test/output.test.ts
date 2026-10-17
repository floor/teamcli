import { describe, expect, test } from 'bun:test';
import {
  buildActionSchemaSpec,
  buildCommandOutputSchema,
  collapseNotes,
  COMMAND_OUTPUT_SCHEMAS,
  contextLine,
  DIFFERENCE_WHO_VALUES,
  ERROR_OUTPUT_SCHEMA,
  formatDeprecationWarning,
  formatHelpExits,
  formatTable,
  jsonEnvelope,
  jsonError,
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
  assertGoldenOutput,
  assertJsonErrorShape,
  assertMatchesOutputSchema,
  assertNoAnsi,
  stripAnsi,
  validateAgainstJsonSchema,
} from './helpers/output.ts';

describe('src/output/ — context line and tables', () => {
  test('contextLine and projectContextLine clean control bytes and format the header', () => {
    expect(contextLine('beacon\x1b[31m', 'beacon\nnext')).toBe('team beacon, session "beacon next"');
    expect(projectContextLine({ name: 'Beacon', id: 'beacon', entity: 'acme', lead: null })).toBe(
      'project Beacon  beacon  entity acme  lead -',
    );
    expect(projectContextLine({ name: 'Beacon', id: 'beacon', entity: null, lead: 'lead-1' })).toBe(
      'project Beacon  beacon  lead lead-1',
    );
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
    expect(renderSummary([diffs[1]!, diffs[3]!])).toBe('2 difference(s), 1 for the owner');
    expect(renderSummary([diffs[1]!])).toBe('1 difference(s)');
    expect(renderSummary([])).toBe('0 difference(s)');
  });

  test('severity vocabulary, deprecation helper, action helpers, and help exits helper', () => {
    expect(SEVERITY_LEVELS).toEqual(['ok', 'warn', 'miss', 'note']);
    expect(SEVERITY_LABELS).toEqual({
      ok: 'ok  ',
      warn: 'warn',
      miss: 'MISS',
      note: '--  ',
    });
    expect(renderFinding({ level: 'ok', text: 'herdr 0.7.1' })).toBe('ok    herdr 0.7.1');
    expect(renderFinding({ level: 'note', text: 'session beacon is running' })).toBe('--    session beacon is running');
    expect(renderFinding({ level: 'warn', text: 'older herdr' })).toBe('warn  older herdr');
    expect(renderFinding({ level: 'miss', text: 'install herdr' })).toBe('MISS  install herdr');

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
    expect(renderActionSummary({ command: 'up', summary: 'started 2 seat(s) in session "acme"' })).toBe(
      'team up: started 2 seat(s) in session "acme"',
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
          warnings: [],
          repaired: [],
          notes: [],
          differences: [],
          summary: { differences: 0, owner_differences: 0 },
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
