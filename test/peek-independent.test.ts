// The parent imports no command or owner-store modules. Each scene starts with its own HOME.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const fixtureRoot = fileURLToPath(new URL('../../peek-independent-fixtures/', import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });
const bases: string[] = [];
afterAll(() => { if (bases.length) spawnSync('trash', bases, { timeout: 20_000 }); }, 30_000);
type Input = { argv?: string[]; caller?: 'owner' | 'seat' | 'foreign' | 'unplaced' | 'owner-no-tty'; dev?: boolean;
  ops?: string[]; entities?: string[]; text?: string | null; missingMethod?: boolean; missingPane?: boolean;
  missingFile?: boolean; badFile?: boolean; invalidState?: boolean };
type Result = { caught?: string; code: number; out: string; err: string; home: string; log: string; stateUnchanged: boolean; configUnchanged: boolean;
  newFiles: string[]; reads: { seat: { name: string; pane: string; cli: string; session: string }; lines: number }[]; factories: { session: string }[] };
function scene(input: Input = {}): Result {
  const base = realpathSync(mkdtempSync(join(fixtureRoot, 'scene-'))); bases.push(base);
  const home = join(base, 'home'); mkdirSync(home);
  const worker = fileURLToPath(new URL('./adapters/peek-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, home, JSON.stringify(input)], {
    cwd: base, env: { HOME: home, PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8', timeout: 20_000,
  });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as Result;
  expect(result.home).toBe(home); expect(result.stateUnchanged).toBe(true); expect(result.configUnchanged).toBe(true);
  expect(result.newFiles.every(name => name === 'team.log')).toBe(true);
  expect(result.log).not.toContain('VISIBLE_ONLY_MARKER');
  return result;
}
function audited(result: Result, caller: string, detail: string) {
  const lines = result.log.trim().split('\n').filter(Boolean);
  expect(lines.some(line => line.includes(' peek [' + caller + '] ' + detail))).toBe(true);
}
function shown(result: Result, caller = 'owner') {
  expect(result.code, result.err).toBe(0); expect(result.out).toBe('VISIBLE_ONLY_MARKER\n');
  expect(result.reads).toEqual([{ seat: { name: 'subject', pane: 'synthetic-subject', cli: 'codex', session: 'lens-session' }, lines: 50 }]);
  expect(result.factories).toEqual([{ session: 'lens-session' }]);
  audited(result, caller, 'team lens: seat subject, 1 line');
}
for (const caller of ['owner', 'seat'] as const) {
  test('the CLI admits the ' + caller + ' and audits one read of the recorded synthetic pane', () => {
    const result = scene({ caller }); shown(result, caller === 'seat' ? 'watcher' : 'owner');
    expect(result.log.trim().split('\n')).toHaveLength(1);
  });
}
for (const ops of [['peek'], ['*']]) {
  test('the real general door admits the signed op ' + ops[0], () => {
    const result = scene({ caller: 'unplaced', ops }); shown(result);
    expect(result.err).toContain('admitted by general grant');
  });
}
test('a signed grant without peek refuses at the dispatcher and reads no screen', () => {
  const result = scene({ caller: 'unplaced', ops: ['status'], argv: ['subject', '--json'] });
  expect(result.code).toBe(1); expect(JSON.parse(result.out).error.id).toBe('team.general-refused');
  expect(result.reads).toEqual([]); expect(result.factories).toEqual([]); expect(result.log).toBe('');
});
test('the dev-mode lift warns and audits its unplaced caller', () => {
  const result = scene({ caller: 'unplaced', dev: true }); shown(result, 'unplaced');
  expect(result.err).toContain('dev mode continues'); audited(result, 'unplaced', 'warning:');
});
for (const caller of ['foreign', 'unplaced', 'owner-no-tty'] as const) {
  test('peek.not-yours refuses ' + caller + ' before obtaining a screen source', () => {
    const result = scene({ caller }); expect(result.code).toBe(2); expect(result.out).toBe('');
    expect(result.err).toContain('this team is not yours to read'); expect(result.reads).toEqual([]); expect(result.factories).toEqual([]);
    audited(result, caller === 'foreign' ? 'watcher' : caller === 'owner-no-tty' ? 'owner' : 'unplaced', 'refused peek.not-yours:');
  });
}
for (const argv of [['missing-seat'], ['synthetic-subject']]) {
  test('peek.unknown refuses an undeclared name, including a raw pane id: ' + argv[0], () => {
    const result = scene({ argv }); expect(result.code).toBe(1); expect(result.out).toBe(''); expect(result.err).toContain('no seat named');
    expect(result.reads).toEqual([]); expect(result.factories).toEqual([]); audited(result, 'owner', 'refused peek.unknown:');
  });
}
for (const input of [{}, { caller: 'unplaced', dev: true }, { caller: 'unplaced', ops: ['*'] }, { caller: 'unplaced', dev: true, ops: ['*'] }] as Input[]) {
  test('peek.owner-pane refuses the human seat even with dev/grant admission: ' + JSON.stringify(input), () => {
    const result = scene({ ...input, argv: ['person'] }); expect(result.code).toBe(1); expect(result.out).toBe('');
    expect(result.err).toContain("owner's pane is never read"); expect(result.reads).toEqual([]); expect(result.factories).toEqual([]);
    audited(result, input.dev && !input.ops ? 'unplaced' : 'owner', 'refused peek.owner-pane: seat person');
  });
}
for (const variant of ['missing-pane', 'missing-method', 'null-screen'] as const) {
  test('peek.no-screen refuses ' + variant + ' and logs the exit id', () => {
    const result = scene({ missingPane: variant === 'missing-pane', missingMethod: variant === 'missing-method', ...(variant === 'null-screen' ? { text: null } : {}) });
    expect(result.code).toBe(2); expect(result.out).toBe(''); expect(result.err).toContain('no screen is readable');
    expect(result.reads).toHaveLength(variant === 'null-screen' ? 1 : 0); audited(result, 'owner', 'refused peek.no-screen: seat subject');
  });
}
for (const bad of [[], ['subject', 'extra'], ['subject', '--bogus'], ['subject', '--lines'], ...['0', '501', '-1', '1.5', 'NaN', '1e2', ' 2'].map(value => ['subject', '--lines', value])]) {
  test('peek.invocation refuses ' + JSON.stringify(bad) + ' before file/screen/audit reads', () => {
    const result = scene({ argv: bad }); expect(result.code).toBe(2); expect(result.out).toBe(''); expect(result.err).toContain('Usage: team peek');
    expect(result.reads).toEqual([]); expect(result.factories).toEqual([]); expect(result.log).toBe('');
  });
}
for (const missingFile of [false, true]) {
  test('peek.file refuses the owner with no audit sink; missing=' + missingFile, () => {
    const result = scene({ badFile: !missingFile, missingFile }); expect(result.code).toBe(2); expect(result.out).toBe('');
    expect(result.err).toContain('team peek:'); expect(result.err).not.toContain('not yours'); expect(result.reads).toEqual([]); expect(result.log).toBe('');
  });
}
test('a pre-load unplaced refusal reveals no file details and writes no audit', () => {
  const result = scene({ caller: 'unplaced', badFile: true }); expect(result.code).toBe(2);
  expect(result.err).toBe('team peek: this team is not yours to read\n'); expect(result.log).toBe(''); expect(result.reads).toEqual([]);
});
const numbered = Array.from({ length: 520 }, (_, n) => 'row ' + String(n + 1).padStart(3, '0'));
for (const lines of [undefined, 1, 500]) {
  test('the exact tail window is used for lines=' + String(lines), () => {
    const wanted = lines ?? 50;
    const result = scene({ argv: lines === undefined ? ['subject'] : ['subject', '--lines', String(lines)], text: numbered.join('\r\n') + '\r\n' });
    expect(result.code).toBe(0); expect(result.reads[0]!.lines).toBe(wanted);
    expect(result.out).toBe(numbered.slice(-wanted).join('\n') + '\n');
    audited(result, 'owner', 'team lens: seat subject, ' + wanted + (wanted === 1 ? ' line' : ' lines'));
    expect(result.log).not.toContain('row ');
  });
}
const sha = '0123456789abcdef0123456789abcdef01234567';
const uuid = '11111111-2222-4333-8444-555555555555';
const planted = [
  'sk-fixture0123456789abcdefghijklmnop', 'ghp_fixture0123456789abcdefghijklmnop', 'AKIAFIXTURE0123456789ABCDEFGHIJ',
  'lin_api_fixture0123456789abcdefghijklmnop', '-----BEGIN PRIVATE KEY-----',
  'synthetic-user:synthetic-password', 'Q7vLm9R2sT8uW3xY5zA1bC6dE0fG4hI8jK2lM7nO9pQ=',
];
test('a planted credential set is masked while full/short shas and UUIDs remain readable', () => {
  const text = planted.map((value, n) => n === 5 ? 'url=https://' + value + '@example.invalid/path' : 'fixture=' + value).join('\n') + '\nsha=' + sha + '\nshort=abc1234\nuuid=' + uuid + '\nVISIBLE_ONLY_MARKER\n';
  const result = scene({ text }); expect(result.code).toBe(0);
  for (const value of planted) { expect(result.out).not.toContain(value); expect(result.log).not.toContain(value); }
  expect(result.out.match(/\[masked\]/g)).toHaveLength(planted.length);
  for (const clear of [sha, 'abc1234', uuid, 'VISIBLE_ONLY_MARKER']) expect(result.out).toContain(clear);
  expect(result.log).not.toContain(sha); expect(result.log).not.toContain(uuid); expect(result.log).not.toContain('[masked]');
});
test('formatting escapes cannot split a credential past the mask', () => {
  const result = scene({ text: 'sk-\x1b[31mfixture0123456789abcdefghijklmnop\x1b[0m\n' });
  expect(result.code).toBe(0); expect(result.out).toContain('[masked]'); expect(result.out).not.toContain('fixture0123456789'); expect(result.out).not.toContain('\x1b');
});
test('all seven command exit ids are pinned to their published numeric codes', () => {
  const contract = JSON.parse(readFileSync(new URL('../contract/exit-codes.json', import.meta.url), 'utf8')) as { rows: { command: string; id: string; code: number }[] };
  expect(Object.fromEntries(contract.rows.filter(row => row.command === 'peek').map(row => [row.id, row.code]))).toEqual({
    'peek.shown': 0, 'peek.unknown': 1, 'peek.owner-pane': 1, 'peek.invocation': 2, 'peek.file': 2, 'peek.not-yours': 2, 'peek.no-screen': 2,
  });
});
test('the command AST has only read imports and its sole source member is screenText', () => {
  const path = new URL('../src/commands/peek.ts', import.meta.url);
  expect(existsSync(path)).toBe(true); if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile('peek.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const allowed = new Set(['node:os', '../args.ts', '../caller.ts', '../delegate.ts', '../dev_mode.ts', '../file/current.ts', '../file/load.ts', '../file/secrets.ts', '../file/types.ts', '../io.ts', '../launch/plain.ts', '../log.ts', '../read-gate.ts', '../state.ts', '../watch/status-events.ts']);
  const sourceMembers: string[] = []; const denied: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) expect(allowed.has((node.moduleSpecifier as ts.StringLiteral).text)).toBe(true);
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(ast) === 'source') sourceMembers.push(node.name.text);
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (/(?:^|\.)(?:typeText|pressEnter|sendKey|sendText|paste|deliver|writeFileSync|appendFileSync|unlinkSync|renameSync|spawnSync|execFileSync|eval)$/.test(name) || node.expression.kind === ts.SyntaxKind.ImportKeyword) denied.push(name);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(denied).toEqual([]); expect(sourceMembers.length).toBeGreaterThan(0); expect(new Set(sourceMembers)).toEqual(new Set(['screenText']));
  expect(raw.match(/currentTeam\([^;]+false\)/s)?.[0]).toBeDefined();
});


test('two userinfo URLs on one line are both masked', () => {
  const result = scene({ text: 'first=https://alice:first-secret@example.invalid/a second=https://bob:second-secret@example.invalid/b\n' });
  expect(result.code).toBe(0);
  for (const value of ['alice:first-secret', 'bob:second-secret']) {
    expect(result.out).not.toContain(value); expect(result.log).not.toContain(value);
  }
  expect(result.out.match(/\[masked\]/g)).toHaveLength(2);
});
for (const prefix of ['ghp_', 'sk-proj-']) {
  for (const wrapper of ['backticks', 'parentheses', 'brackets', 'colon']) {
    test('a ' + prefix + ' token inside ' + wrapper + ' is masked', () => {
      const token = prefix + 'fixture0123456789abcdefghijklmnop';
      const frame = wrapper === 'backticks' ? '`' + token + '`' : wrapper === 'parentheses' ? '(' + token + ')' : wrapper === 'brackets' ? '[' + token + ']' : 'credential:' + token;
      const result = scene({ text: 'visible ' + frame + ' suffix\n' });
      expect(result.code).toBe(0); expect(result.out).not.toContain(token); expect(result.out).toContain('[masked]');
      expect(result.log).not.toContain(token);
    });
  }
}
test('username-only token userinfo is masked without a password delimiter', () => {
  const token = 'ghp_fixture0123456789abcdefghijklmnop';
  const result = scene({ text: 'https://' + token + '@example.invalid/path\n' });
  expect(result.code).toBe(0); expect(result.out).not.toContain(token); expect(result.out).toContain('[masked]');
  expect(result.log).not.toContain(token);
});
test('invalid recorded state refuses with an audit row instead of throwing', () => {
  const result = scene({ invalidState: true });
  expect(result.caught).toBeUndefined(); expect(result.code).toBe(2); expect(result.out).toBe('');
  expect(result.reads).toEqual([]); audited(result, 'owner', 'refused peek.no-screen:');
});


function splitRows(value: string, cuts: number[]): string[] {
  return [0, ...cuts].map((start, index, all) => value.slice(start, all[index + 1] ?? value.length));
}
const wrappedBody = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
for (const prefix of ['ghp_', 'sk-proj-']) {
  const token = prefix + wrappedBody;
  for (const cut of [1, 3, prefix.length, prefix.length + 10, token.length - 1]) {
    test('a wrapped ' + prefix + ' key masks both rows at offset ' + cut, () => {
      const rows = splitRows(token, [cut]);
      const result = scene({ text: rows.join('\n') + '\n' });
      expect(result.code).toBe(0); expect(result.out).toBe(rows.map(() => '[masked]').join('\n') + '\n');
      expect(result.log).not.toContain(token); audited(result, 'owner', 'seat subject, 2 lines');
    });
  }
  for (const cuts of [[1, 3], [prefix.length, prefix.length + 10], [10, 24]]) {
    test('a wrapped ' + prefix + ' key masks all three rows at offsets ' + cuts.join('/'), () => {
      const rows = splitRows(token, cuts);
      const result = scene({ text: rows.join('\n') + '\n' });
      expect(result.code).toBe(0); expect(result.out).toBe('[masked]\n[masked]\n[masked]\n');
      audited(result, 'owner', 'seat subject, 3 lines');
    });
  }
}
const wrappedUrl = 'https://alice:synthetic-password@example.invalid/path';
for (const cuts of [[3], [8], [10], [14], [wrappedUrl.indexOf('@') - 3], [8, 14], [10, wrappedUrl.indexOf('@') - 2]]) {
  test('wrapped URL userinfo is fully masked across row offsets ' + cuts.join('/'), () => {
    const rows = splitRows(wrappedUrl, cuts);
    const userStart = wrappedUrl.indexOf('://') + 3;
    const userEnd = wrappedUrl.indexOf('@');
    let rowStart = 0;
    const expected = rows.map(row => {
      const start = Math.max(userStart, rowStart) - rowStart;
      const end = Math.min(userEnd, rowStart + row.length) - rowStart;
      rowStart += row.length;
      return start < end ? row.slice(0, start) + '[masked]' + row.slice(end) : row;
    });
    const result = scene({ text: rows.join('\n') + '\n' });
    expect(result.code).toBe(0); expect(result.out).toBe(expected.join('\n') + '\n');
    expect(result.log).not.toContain('alice'); expect(result.log).not.toContain('synthetic-password');
    audited(result, 'owner', 'seat subject, ' + rows.length + ' lines');
  });
}
for (const cut of [1, 7, 20, 39]) {
  test('a wrapped full SHA stays readable at offset ' + cut, () => {
    const text = splitRows(sha, [cut]).join('\n') + '\n';
    const result = scene({ text }); expect(result.code).toBe(0); expect(result.out).toBe(text);
    expect(result.out).not.toContain('[masked]');
  });
}
test('the reviewer two-row probe hides ghp_ plus ten characters and the following twenty-six', () => {
  const result = scene({ text: 'ghp_0123456789\nabcdefghijklmnopqrstuvwxyz\n' });
  expect(result.code).toBe(0); expect(result.out).toBe('[masked]\n[masked]\n');
  expect(result.log).not.toContain('0123456789'); expect(result.log).not.toContain('abcdefghijklmnopqrstuvwxyz');
});
