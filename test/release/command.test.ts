// `team release check` end to end: the specification's two output examples byte for byte, the
// exit codes, the error precedence, the exact URL set of one run, and read-only by construction.
// The fetch is the answer map throughout; one test stubs globalThis.fetch to see the production
// wiring's request — no test makes a real network request.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, USAGE as CHECK_USAGE } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { runRelease, USAGE as RELEASE_USAGE } from '../../src/commands/release.ts';
import { main } from '../../src/cli.ts';
import { realFetch, BODY_LIMIT } from '../../src/release/http.ts';
import type { KeyReader } from '../../src/release/keychain.ts';
import { gitEnv, testIo, type TestIo } from '../helpers.ts';
import {
  KEY, URLS, activityFile, fakeFetch, fixture, happy, happyRecords, json, linearAnswer, withChange, type Answers, type Recorded,
} from './world.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
releases:
  - package: material
    github: floor/material
    trusted_publishing: true
  - package: "@scope/tool"
    github: floor/tool
  - package: widgets
    github: floor/material
    linear_project: 01234567-89ab-cdef-0123-456789abcdef
    linear_keychain_service: team.linear.material
    activity_file: activity/2026/material.md
    activity_marker: "release: <package>@<version>"
  - package: gadgets
    github: floor/material
    activity_file: activity/2026/material.md
    activity_marker: "release: <package>@<version>"
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

// The specification's example run: npm pass with provenance, the tag not ancestral, the release
// and the changelog right — one check missing, exit 1.
function specAnswers(): Answers {
  return new Map([...happy(), [URLS.compare, json({ ...fixture('github-compare.json'), status: 'behind' })]]);
}

const SPEC_ROWS = `package material, version 3.0.2
  CHECK      STATE    DETAIL
  npm        pass     exact version, checksums, and provenance found
  tag        missing  tag commit is not an ancestor of the default branch
  github     pass     published release matches SemVer channel
  changelog  pass     changelog entry has a valid release date
`;

const SPEC_TABLE = `${SPEC_ROWS}4 check(s), 1 missing
`;

const SPEC_JSON = `{
  "schema": {
    "name": "team.release",
    "version": 1
  },
  "format": 1,
  "package": "material",
  "version": "3.0.2",
  "rows": [
    {
      "check": "npm",
      "state": "pass",
      "detail": "exact version, checksums, and provenance found"
    },
    {
      "check": "tag",
      "state": "missing",
      "detail": "tag commit is not an ancestor of the default branch"
    },
    {
      "check": "github",
      "state": "pass",
      "detail": "published release matches SemVer channel"
    },
    {
      "check": "changelog",
      "state": "pass",
      "detail": "changelog entry has a valid release date"
    }
  ],
  "summary": {
    "checks": 4,
    "missing": 1
  }
}
`;

/* The warning's own text for the standard 3.0.2 declaration, and the answers that produce it:
 * npm's `next` dist-tag one patch behind `latest`. */
const STALE_NEXT = "npm's next dist-tag points at 3.0.1, older than latest 3.0.2: run npm dist-tag add material@3.0.2 next";

function staleNext(answers: Answers): Answers {
  return withChange(answers, URLS.tags, () => ({ latest: '3.0.2', next: '3.0.1' }));
}

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'team-release-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project, stdio: ['ignore', 'ignore', 'ignore'] });
  mkdirSync(join(project, '.agents'));
  writeFileSync(join(project, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

async function run(argv: string[], answers: Answers, keyReader?: KeyReader, cwd: string = project): Promise<{ code: number; io: TestIo; requested: string[]; requests: Recorded[] }> {
  const { fetcher, requested, requests } = fakeFetch(answers);
  const io = testIo(cwd);
  return { code: await runRelease(argv, io, fetcher, keyReader), io, requested, requests };
}

function listing(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (entry.isDirectory()) out.push(...listing(join(dir, entry.name)).map((name) => `${entry.name}/${name}`));
    else out.push(entry.name);
  }
  return out.sort();
}

/** The `team.error` document a refusal writes under `--json`: the shared envelope, no repair. */
function errorDoc(id: string, message: string): unknown {
  return { schema: { name: 'team.error', version: 1 }, error: { id, message, repair: null } };
}

describe('the output', () => {
  test('the specification\'s table example, byte for byte, exit 1', async () => {
    const { code, io } = await run(['check', 'material@3.0.2'], specAnswers());
    expect(code).toBe(1);
    expect(io.out).toBe(SPEC_TABLE);
    expect(io.err).toBe('');
  });

  test('the specification\'s JSON example, byte for byte, exit 1', async () => {
    const { code, io } = await run(['check', 'material@3.0.2', '--json'], specAnswers());
    expect(code).toBe(1);
    expect(io.out).toBe(SPEC_JSON);
    expect(io.err).toBe('');
  });

  test('exit 0 when every check passes', async () => {
    const { code } = await run(['check', 'material@3.0.2'], happy());
    expect(code).toBe(0);
  });

  test('a stale next tag adds one warn line after the table, changing no status and no exit', async () => {
    const { code, io } = await run(['check', 'material@3.0.2'], staleNext(specAnswers()));
    expect(code).toBe(1);
    expect(io.out).toBe(`${SPEC_ROWS}warn  ${STALE_NEXT}\n4 check(s), 1 missing\n`);
    expect(io.err).toBe('');
  });

  test('a warning on an otherwise passing run: every row pass, still exit 0', async () => {
    const { code, io } = await run(['check', 'material@3.0.2'], staleNext(happy()));
    expect(code).toBe(0);
    expect(io.out).toBe(`package material, version 3.0.2
  CHECK      STATE  DETAIL
  npm        pass   exact version, checksums, and provenance found
  tag        pass   tag resolves to a commit on the default branch
  github     pass   published release matches SemVer channel
  changelog  pass   changelog entry has a valid release date
warn  ${STALE_NEXT}
4 check(s), 0 missing
`);
  });

  test('--json carries the warning after the summary, and only when there is one', async () => {
    const stale = await run(['check', 'material@3.0.2', '--json'], staleNext(specAnswers()));
    expect(stale.code).toBe(1);
    expect(stale.io.out.endsWith(`  },\n  "warning": ${JSON.stringify(STALE_NEXT)}\n}\n`)).toBe(true);
    const level = await run(['check', 'material@3.0.2', '--json'], happy());
    expect(level.code).toBe(0);
    expect(level.io.out).not.toContain('warning');
  });

  test('exit 2 when any check is unknown, even with another missing', async () => {
    const answers = specAnswers();
    answers.set(URLS.npm, [json({}, 500), json({}, 500)]);
    const { code, io } = await run(['check', 'material@3.0.2'], answers);
    expect(code).toBe(2);
    expect(io.out).toContain('npm        unknown');
  });

  test('one full run requests exactly the twelve endpoints, all HTTPS, in order', async () => {
    // The same maximal shape as the caps test: trusted publishing, a chain of tag objects.
    const { requested } = await run(['check', 'material@3.0.2'], happy());
    expect(requested).toEqual([URLS.npm, URLS.attest, URLS.tags, URLS.repo, URLS.ref, URLS.compare, URLS.release, URLS.changelog]);
    for (const url of requested) expect(url).toStartWith('https://');
  });

  test('a scoped package splits at the final @ and encodes as one segment', async () => {
    const { code, requested } = await run(['check', '@scope/tool@1.2.3'], new Map());
    expect(code).toBe(2);
    expect(requested[0]).toBe('https://registry.npmjs.org/%40scope%2Ftool/1.2.3');
  });
});

// The records run for widgets@3.0.2 (both pairs configured, no trusted publishing): the same
// public records — the file points widgets at the same repository — plus the marker with the
// requested literal values and the Linear answer.
function widgetsAnswers(): Answers {
  const answers = happyRecords();
  answers.set('https://registry.npmjs.org/widgets/3.0.2', json({ ...fixture('npm-version.json'), name: 'widgets' }));
  answers.set(URLS.activity, json(activityFile('# Activity\n\nrelease: widgets@3.0.2\n')));
  return answers;
}

// gadgets configures the activity pair only.
function gadgetsAnswers(): Answers {
  const answers = happy(false);
  answers.set('https://registry.npmjs.org/gadgets/3.0.2', json({ ...fixture('npm-version.json'), name: 'gadgets' }));
  answers.set(URLS.activity, json(activityFile('release: gadgets@3.0.2\n')));
  return answers;
}

const okKey: KeyReader = () => Promise.resolve({ ok: true, key: KEY });

describe('the output with the records configured', () => {
  const WIDGETS_TABLE = `package widgets, version 3.0.2
  CHECK      STATE  DETAIL
  npm        pass   exact version and checksums found
  tag        pass   tag resolves to a commit on the default branch
  github     pass   published release matches SemVer channel
  changelog  pass   changelog entry has a valid release date
  linear     pass   Linear milestone is complete and a qualifying status update exists
  activity   pass   public activity marker found
6 check(s), 0 missing
`;

  const WIDGETS_JSON = `{
  "schema": {
    "name": "team.release",
    "version": 1
  },
  "format": 1,
  "package": "widgets",
  "version": "3.0.2",
  "rows": [
    {
      "check": "npm",
      "state": "pass",
      "detail": "exact version and checksums found"
    },
    {
      "check": "tag",
      "state": "pass",
      "detail": "tag resolves to a commit on the default branch"
    },
    {
      "check": "github",
      "state": "pass",
      "detail": "published release matches SemVer channel"
    },
    {
      "check": "changelog",
      "state": "pass",
      "detail": "changelog entry has a valid release date"
    },
    {
      "check": "linear",
      "state": "pass",
      "detail": "Linear milestone is complete and a qualifying status update exists"
    },
    {
      "check": "activity",
      "state": "pass",
      "detail": "public activity marker found"
    }
  ],
  "summary": {
    "checks": 6,
    "missing": 0
  }
}
`;

  test('all six rows in the fixed order, exit 0', async () => {
    const { code, io } = await run(['check', 'widgets@3.0.2'], widgetsAnswers(), okKey);
    expect(code).toBe(0);
    expect(io.out).toBe(WIDGETS_TABLE);
    expect(io.err).toBe('');
  });

  test('the JSON object has exactly the six keys in the fixed order', async () => {
    const { code, io } = await run(['check', 'widgets@3.0.2', '--json'], widgetsAnswers(), okKey);
    expect(code).toBe(0);
    expect(io.out).toBe(WIDGETS_JSON);
    expect(io.err).toBe('');
  });

  test('a check that is not configured is absent: the activity pair alone adds one row', async () => {
    const { code, io } = await run(['check', 'gadgets@3.0.2'], gadgetsAnswers());
    expect(code).toBe(0);
    expect(io.out).toContain('activity   pass   public activity marker found');
    expect(io.out).not.toContain('linear');
  });

  test('the exit rule spans the present checks: a missing linear is 1, an unknown one is 2', async () => {
    const missing = await run(
      ['check', 'widgets@3.0.2'],
      new Map([...widgetsAnswers(), [URLS.linear, json(linearAnswer({ milestones: [] }))]]),
      okKey,
    );
    expect(missing.code).toBe(1);
    expect(missing.io.out).toContain('no matching Linear milestone found');

    const noKey: KeyReader = () => Promise.resolve({ ok: false, reason: 'the lookup failed' });
    const unknown = await run(['check', 'widgets@3.0.2'], widgetsAnswers(), noKey);
    expect(unknown.code).toBe(2);
    expect(unknown.io.out).toContain('Keychain access was unavailable');
  });

  test('without an injected reader, the non-interactive default never invokes the facility', async () => {
    // The default wiring reads io.stdinIsTTY — false here — and does not look up anything.
    const { code, io, requested } = await run(['check', 'widgets@3.0.2'], widgetsAnswers());
    expect(code).toBe(2);
    expect(io.out).toContain('Keychain access was unavailable');
    expect(requested).not.toContain(URLS.linear);
  });
});

describe('the key appears nowhere but the one request header', () => {
  // The key under test is the distinctive non-real string of world.ts. After each scenario,
  // everything the command produced is searched: standard output, standard error, any thrown
  // error's message and stack, the recorded requests (URLs, bodies, header names and values),
  // the arguments the fake key reader saw, and the project's file listing.
  const calls: string[] = [];
  const recording: KeyReader = (service) => {
    calls.push(service);
    return Promise.resolve({ ok: true, key: KEY });
  };

  function searched(io: TestIo, requests: Recorded[], thrown: unknown): number {
    const text = [io.out, io.err, thrown instanceof Error ? `${thrown.message}\n${thrown.stack ?? ''}` : String(thrown ?? '')].join('\n');
    expect(text).not.toContain(KEY);
    for (const service of calls) expect(service).toBe('team.linear.material');
    let carried = 0;
    for (const record of requests) {
      expect(record.url).not.toContain(KEY);
      expect(record.request?.body ?? '').not.toContain(KEY);
      for (const [name, value] of Object.entries(record.request?.headers ?? {})) {
        expect(name).not.toContain(KEY);
        if (value.includes(KEY)) {
          expect({ url: record.url, name }).toEqual({ url: URLS.linear, name: 'Authorization' });
          carried++;
        }
      }
    }
    return carried;
  }

  async function attempt(answers: Answers): Promise<{ code: number; io: TestIo; requests: Recorded[]; thrown: unknown }> {
    calls.length = 0;
    try {
      const { code, io, requests } = await run(['check', 'widgets@3.0.2'], answers, recording);
      return { code, io, requests, thrown: undefined };
    } catch (error) {
      // A throw is itself a finding to search: nothing the error carries may hold the key.
      return { code: -1, io: testIo(project), requests: [], thrown: error };
    }
  }

  test('all pass: exactly one attempt, exactly one header carries the key, nothing else does', async () => {
    const { code, io, requests, thrown } = await attempt(widgetsAnswers());
    expect(code).toBe(0);
    expect(searched(io, requests, thrown)).toBe(1);
    expect(calls).toEqual(['team.linear.material']);
  });

  test('401, 403, 500 twice, a timeout, invalid JSON, a 200 with errors, a redirect', async () => {
    const scenarios: [string, Answers, number][] = [
      ['401', new Map([...widgetsAnswers(), [URLS.linear, json({}, 401)]]), 1],
      ['403', new Map([...widgetsAnswers(), [URLS.linear, json({}, 403)]]), 1],
      ['500 twice', new Map([...widgetsAnswers(), [URLS.linear, [json({}, 500), json({}, 500)]]]), 2],
      ['a timeout', new Map([...widgetsAnswers(), [URLS.linear, { kind: 'timeout' }]]), 2],
      ['invalid JSON', new Map([...widgetsAnswers(), [URLS.linear, { kind: 'http', status: 200, body: '{"data":' }]]), 1],
      ['200 with errors', new Map([...widgetsAnswers(), [URLS.linear, json({ data: null, errors: [{ message: 'nope' }] })]]), 1],
      ['a redirect', new Map([...widgetsAnswers(), [URLS.linear, json({}, 302)]]), 1],
    ];
    for (const [name, answers, attempts] of scenarios) {
      const { code, io, requests, thrown } = await attempt(answers);
      expect({ name, code }).toEqual({ name, code: 2 });
      expect(io.out).toContain('Linear record could not be read');
      expect(searched(io, requests, thrown)).toBe(attempts);
    }
  });

  test('the --json output is searched as well: exactly one header carries the key', async () => {
    calls.length = 0;
    const { code, io, requests } = await run(['check', 'widgets@3.0.2', '--json'], widgetsAnswers(), recording);
    expect(code).toBe(0);
    expect(io.out).toContain('"check": "linear",\n      "state": "pass"');
    expect(searched(io, requests, undefined)).toBe(1);
  });

  test('a key reader that fails, times out, or returns empty or illegal output: no request, no leak', async () => {
    // The reader reports the deadline's outcome itself (the production seam terminates the lookup
    // at five seconds); every not-ok answer is the same Keychain failure, and no request is formed.
    const readers: KeyReader[] = [
      () => Promise.resolve({ ok: false, reason: 'the lookup failed' }),
      () => Promise.resolve({ ok: false, reason: 'the lookup timed out' }),
      () => Promise.resolve({ ok: true, key: '' }),
      () => Promise.resolve({ ok: true, key: 'not a legal key' }),
    ];
    for (const reader of readers) {
      calls.length = 0;
      const { code, io, requests } = await run(['check', 'widgets@3.0.2'], widgetsAnswers(), reader);
      expect(code).toBe(2);
      expect(io.out).toContain('Keychain access was unavailable');
      expect(requests.filter((record) => record.url === URLS.linear)).toEqual([]);
      expect(searched(io, requests, undefined)).toBe(0);
    }
  });

  test('a response body that itself contains the key string is not echoed anywhere', async () => {
    const answers = new Map([...widgetsAnswers(), [URLS.linear, json(linearAnswer({ milestones: [{ name: KEY, status: 'done' }] }))]]);
    const { code, io, requests, thrown } = await attempt(answers);
    expect(code).toBe(1);
    expect(io.out).toContain('no matching Linear milestone found');
    expect(searched(io, requests, thrown)).toBe(1);
  });

  test('the records run writes nothing: the project is byte-identical afterwards', async () => {
    const before = listing(project);
    await attempt(widgetsAnswers());
    expect(listing(project)).toEqual(before);
  });
});

describe('read-only by construction', () => {
  test('the run writes nothing: the project is byte-identical afterwards', async () => {
    const before = listing(project);
    await run(['check', 'material@3.0.2'], happy());
    expect(listing(project)).toEqual(before);
  });

  test('its modules import no filesystem write and, but for the one Keychain seam, no process spawn', () => {
    for (const module of ['commands/release.ts', 'release/checks.ts', 'release/http.ts', 'release/grammar.ts', 'release/keychain.ts', 'file/sections/releases.ts']) {
      const source = readFileSync(join(import.meta.dir, '..', '..', 'src', module), 'utf8');
      expect(source).not.toContain("from 'node:fs'");
      expect(source).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync/);
      // The Keychain seam is the command's one sanctioned spawn; every test stands in for it.
      if (module !== 'release/keychain.ts') expect(source).not.toContain('node:child_process');
    }
  });
});

describe('the production wiring', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test('sends no authorization header, follows no redirect, sets the timeout', async () => {
    let seen: RequestInit | undefined;
    let asked = false;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      asked = true;
      seen = init;
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof fetch;
    const attempt = await realFetch('https://registry.npmjs.org/material/3.0.2');
    expect(attempt).toEqual({ kind: 'http', status: 200, body: '{"ok":true}' });
    expect(asked).toBe(true);
    expect(seen?.headers).toBeUndefined();
    expect(JSON.stringify(seen ?? {})).not.toContain('uthorization');
    expect(seen?.redirect).toBe('manual');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  test('a body over one megabyte decoded is the size-limit failure, with the response status and the decoded head', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('x'.repeat(BODY_LIMIT + 1), { status: 200 }))) as unknown as typeof fetch;
    expect(await realFetch('https://registry.npmjs.org/material/3.0.2')).toEqual({
      kind: 'too-large',
      status: 200,
      prefix: 'x'.repeat(BODY_LIMIT),
    });
  });

  test('the head kept stops at the limit, and a character the cut splits is dropped, not repaired', async () => {
    // The body is one byte past the limit with the limit falling inside a two-byte character
    // (é is 0xc3 0xa9): the head holds the first limit bytes and the split character is dropped,
    // never read as a replacement character.
    const head = 'x'.repeat(BODY_LIMIT - 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(head));
        controller.enqueue(new Uint8Array([0xc3, 0xa9, 0x41]));
        controller.close();
      },
    });
    globalThis.fetch = (() => Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;
    expect(await realFetch('https://registry.npmjs.org/material/3.0.2')).toEqual({ kind: 'too-large', status: 200, prefix: head });
  });

  test('a body that is not valid UTF-8 is the undecodable failure, with the response status', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), { status: 200 }))) as unknown as typeof fetch;
    expect(await realFetch('https://registry.npmjs.org/material/3.0.2')).toEqual({ kind: 'undecodable', status: 200 });
  });
});

describe('the usage and configuration errors', () => {
  test('each misuse exits 2 with one diagnostic on stderr and no table', async () => {
    const cases: string[][] = [
      [],
      ['status'],
      ['check'],
      ['check', 'material@3.0.2', 'extra'],
      ['check', 'material@3.0.2', '--table'],
      ['check', 'material'],
      ['check', '@1.2.3'],
      ['check', 'Material@3.0.2'],
      ['check', 'material@v3.0.2'],
      ['check', 'material@3.0'],
      ['check', 'material@03.0.2'],
    ];
    for (const argv of cases) {
      const { code, io, requested } = await run(argv, happy());
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(io.out).toBe('');
      const lines = io.err.split('\n').filter((line) => line !== '');
      expect(lines.length).toBe(1);
      expect(lines[0]).toStartWith('team release: ');
      expect(requested).toEqual([]);
    }
  });

  test('with --json a misuse is the exact error object on stdout, nothing on stderr', async () => {
    const { code, io } = await run(['check', 'material@v3.0.2', '--json'], happy());
    expect(code).toBe(2);
    expect(JSON.parse(io.out)).toEqual(errorDoc('release.usage', 'the version "v3.0.2" is not a Semantic Versioning 2.0.0 version'));
    expect(io.err).toBe('');
  });

  test('--json decides the reporting wherever it appears, even after an unknown option', async () => {
    for (const argv of [
      ['check', 'material@3.0.2', '--bogus', '--json'],
      ['--json', 'check', 'material@3.0.2', '--bogus'],
    ]) {
      const { code, io } = await run(argv, happy());
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(JSON.parse(io.out)).toEqual(errorDoc('release.usage', 'unknown option --bogus'));
      expect(io.err).toBe('');
    }
  });

  test('the precedence: an invalid argument is usage even when the file is invalid', async () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 1\nproject: acme\n');
    const { code, io } = await run(['check', 'material@v3.0.2', '--json'], happy());
    expect(code).toBe(2);
    expect(JSON.parse(io.out)).toEqual(errorDoc('release.usage', 'the version "v3.0.2" is not a Semantic Versioning 2.0.0 version'));
  });

  test('a valid argument with an invalid file is configuration', async () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), 'format: 1\nproject: acme\n');
    const { code, io } = await run(['check', 'material@3.0.2', '--json'], happy());
    expect(code).toBe(2);
    const parsed = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(parsed.error.id).toBe('release.configuration');
    expect(parsed.error.message.length).toBeGreaterThan(0);
    expect(io.err).toBe('');

    const plain = await run(['check', 'material@3.0.2'], happy());
    expect(plain.code).toBe(2);
    expect(plain.io.out).toBe('');
    expect(plain.io.err.split('\n').filter((line) => line !== '').length).toBe(1);
    expect(plain.io.err).toContain('team release: ');
  });

  test('an undeclared package is usage, with and without a releases section', async () => {
    const { code, io } = await run(['check', 'other@3.0.2', '--json'], happy());
    expect(code).toBe(2);
    expect(JSON.parse(io.out)).toEqual(errorDoc('release.usage', 'other is not declared in the team file\'s releases'));

    writeFileSync(join(project, '.agents', 'team.yaml'), TEAM.replace(/^releases:\n(?:  .*\n)+/m, ''));
    const bare = await run(['check', 'material@3.0.2', '--json'], happy());
    expect(bare.code).toBe(2);
    expect(JSON.parse(bare.io.out)).toEqual(errorDoc('release.usage', 'material is not declared in the team file\'s releases'));
  });

  test('a file that fails validation because of its releases section is configuration', async () => {
    writeFileSync(join(project, '.agents', 'team.yaml'), TEAM.replace('seats:', '  - package: material\n    github: floor/other\nseats:'));
    const { code, io } = await run(['check', 'material@3.0.2', '--json'], happy());
    expect(code).toBe(2);
    const parsed = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(parsed.error.id).toBe('release.configuration');
    expect(parsed.error.message).toContain('releases names "material" twice');
  });
});

describe('the --file option', () => {
  test('reads the named file: the value resolves against the working directory, in every form', async () => {
    for (const argv of [
      ['check', 'material@3.0.2', '--file', '.agents/team.yaml'],
      ['check', 'material@3.0.2', '--file=.agents/team.yaml'],
      ['check', '--file', '.agents/team.yaml', 'material@3.0.2'],
    ]) {
      const { code, io, requested } = await run(argv, happy());
      expect({ argv, code }).toEqual({ argv, code: 0 });
      expect(io.err).toBe('');
      expect(requested.length).toBeGreaterThan(0);
    }
  });

  test('an absent named file is configuration: one line on stderr, or the error object with --json', async () => {
    const plain = await run(['check', 'material@3.0.2', '--file', 'missing.yaml'], happy());
    expect(plain.code).toBe(2);
    expect(plain.io.out).toBe('');
    expect(plain.io.err).toBe(`team release: ${join(project, 'missing.yaml')}: no team file at missing.yaml\n`);
    expect(plain.requested).toEqual([]);

    const json = await run(['check', 'material@3.0.2', '--file', 'missing.yaml', '--json'], happy());
    expect(json.code).toBe(2);
    expect(json.io.err).toBe('');
    expect(JSON.parse(json.io.out)).toEqual(errorDoc('release.configuration', `${join(project, 'missing.yaml')}: no team file at missing.yaml`));
    expect(json.requested).toEqual([]);
  });

  test('a named file that fails validation is configuration, in both shapes', async () => {
    writeFileSync(join(project, 'invalid.yaml'), 'format: 2\n');
    const plain = await run(['check', 'material@3.0.2', '--file', 'invalid.yaml'], happy());
    expect(plain.code).toBe(2);
    expect(plain.io.out).toBe('');
    expect(plain.io.err.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(plain.io.err).toContain('team release: ');
    expect(plain.io.err).toContain('invalid.yaml');
    expect(plain.requested).toEqual([]);

    const json = await run(['check', 'material@3.0.2', '--file', 'invalid.yaml', '--json'], happy());
    expect(json.code).toBe(2);
    expect(json.io.err).toBe('');
    const parsed = JSON.parse(json.io.out) as { error: { id: string; message: string } };
    expect(parsed.error.id).toBe('release.configuration');
    expect(parsed.error.message).toContain('invalid.yaml');
    expect(json.requested).toEqual([]);
  });

  test('a missing value is usage; the last value wins when the option is given twice', async () => {
    for (const argv of [
      ['check', 'material@3.0.2', '--file'],
      ['check', 'material@3.0.2', '--file', ''],
      ['check', 'material@3.0.2', '--file='],
    ]) {
      const plain = await run(argv, happy());
      expect({ argv, code: plain.code }).toEqual({ argv, code: 2 });
      expect(plain.io.out).toBe('');
      expect(plain.io.err).toBe('team release: --file needs a value\n');
      expect(plain.requested).toEqual([]);
    }
    const withJson = await run(['check', 'material@3.0.2', '--json', '--file'], happy());
    expect(withJson.code).toBe(2);
    expect(JSON.parse(withJson.io.out)).toEqual(errorDoc('release.usage', '--file needs a value'));
    expect(withJson.io.err).toBe('');
    expect(withJson.requested).toEqual([]);

    // `team commits check --file` also reads one value per option, last one wins; the parsers are
    // separate and the table test below holds them to the same classification, so the last
    // occurrence is the file. Both orders pin which one is used.
    const last = await run(['check', 'material@3.0.2', '--file', 'missing.yaml', '--file', '.agents/team.yaml'], happy());
    expect(last.code).toBe(0);
    const first = await run(['check', 'material@3.0.2', '--file', '.agents/team.yaml', '--file', 'missing.yaml'], happy());
    expect(first.code).toBe(2);
    expect(first.io.err).toContain('no team file at missing.yaml');
    expect(first.requested).toEqual([]);
  });

  test('--json as the value of --file is a path: only a --json that is not a value selects JSON', async () => {
    const consumed = await run(['check', 'material@3.0.2', '--file', '--json'], happy());
    expect(consumed.code).toBe(2);
    expect(consumed.io.out).toBe('');
    expect(consumed.io.err).toBe(`team release: ${join(project, '--json')}: no team file at --json\n`);
    expect(consumed.requested).toEqual([]);

    const marked = errorDoc('release.configuration', `${join(project, '--json')}: no team file at --json`);
    for (const argv of [
      ['check', 'material@3.0.2', '--json', '--file', '--json'],
      ['check', 'material@3.0.2', '--file', '--json', '--json'],
    ]) {
      const { code, io, requested } = await run(argv, happy());
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(io.err).toBe('');
      expect(JSON.parse(io.out)).toEqual(marked);
      expect(requested).toEqual([]);
    }
  });

  test('in a linked worktree, the default is the main checkout\'s file and --file reads the named one', async () => {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'Start'], { cwd: project, stdio: ['ignore', 'ignore', 'ignore'], env: gitEnv() });
    const worktree = join(project, 'wt');
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'side', worktree], { cwd: project, stdio: ['ignore', 'ignore', 'ignore'] });
    mkdirSync(join(worktree, '.agents'), { recursive: true });
    writeFileSync(join(worktree, '.agents', 'team.yaml'), TEAM.replace(/^releases:\n(?:  .*\n)+/m, 'releases:\n  - package: gadgets\n    github: floor/material\n'));

    // No --file: the main checkout's file, found through the common directory — material is declared.
    const byDefault = await run(['check', 'material@3.0.2'], happy(), undefined, worktree);
    expect(byDefault.code).toBe(0);

    // The named file is the one read: the worktree's declares no material.
    const named = await run(['check', 'material@3.0.2', '--file', '.agents/team.yaml', '--json'], happy(), undefined, worktree);
    expect(named.code).toBe(2);
    expect(named.io.err).toBe('');
    expect(JSON.parse(named.io.out)).toEqual(errorDoc('release.usage', 'material is not declared in the team file\'s releases'));
    expect(named.requested).toEqual([]);

    // The same option can name the main checkout's file from the worktree.
    const mainFile = await run(['check', 'material@3.0.2', '--file', join(project, '.agents', 'team.yaml')], happy(), undefined, worktree);
    expect(mainFile.code).toBe(0);
  });

  test('the precedence holds with --file: an invalid argument is usage even when the file is invalid', async () => {
    writeFileSync(join(project, 'invalid.yaml'), 'format: 2\n');
    const both = await run(['check', 'material@v3.0.2', '--file', 'invalid.yaml', '--json'], happy());
    expect(both.code).toBe(2);
    expect(JSON.parse(both.io.out)).toEqual(errorDoc('release.usage', 'the version "v3.0.2" is not a Semantic Versioning 2.0.0 version'));
    expect(both.requested).toEqual([]);

    const undeclared = await run(['check', 'other@3.0.2', '--file', 'missing.yaml', '--json'], happy());
    expect(undeclared.code).toBe(2);
    const parsed = JSON.parse(undeclared.io.out) as { error: { id: string; message: string } };
    expect(parsed.error.id).toBe('release.configuration');
    expect(parsed.error.message).toContain('no team file at missing.yaml');
    expect(undeclared.requested).toEqual([]);
  });

  test('no misuse reads a key or opens a transport: both seams throw if called', async () => {
    writeFileSync(join(project, 'invalid.yaml'), 'format: 2\n');
    writeFileSync(join(project, 'empty.yaml'), '');
    const cases: string[][] = [
      ['check', 'material@3.0.2', '--file'],
      ['check', 'material@3.0.2', '--json', '--file'],
      ['check', 'material@3.0.2', '--file='],
      ['check', 'material@3.0.2', '--file', ''],
      ['check', 'material@3.0.2', '--file', 'missing.yaml'],
      ['check', 'material@3.0.2', '--file', 'invalid.yaml'],
      ['check', 'material@3.0.2', '--file', 'empty.yaml'],
      ['check', 'material@3.0.2', '--file', '--json'],
      ['check', 'other@3.0.2', '--file', '.agents/team.yaml'],
      ['check', 'other@3.0.2', '--file', 'missing.yaml'],
      ['check', 'material@v3.0.2', '--file', 'invalid.yaml'],
      ['check', 'material@3.0.2', 'extra', '--file', '.agents/team.yaml'],
    ];
    for (const argv of cases) {
      const io = testIo(project);
      const transport = (): never => {
        throw new Error('the transport was called');
      };
      const reader = (): never => {
        throw new Error('the key was read');
      };
      const code = await runRelease(argv, io, transport, reader);
      expect({ argv, code }).toEqual({ argv, code: 2 });
    }
  });

  test('--help anywhere wins over the value rule: --file --help is the usage, exit 0', async () => {
    // The page says `--help`/`-h` are answered before the arguments are parsed; the value rule
    // governs `--json` only. The dispatcher checks the raw arguments, so both commands agree.
    const releaseIo = testIo(project);
    expect(await main(['release', 'check', 'material@3.0.2', '--file', '--help'], releaseIo)).toBe(0);
    expect(releaseIo.out).toBe(RELEASE_USAGE);
    expect(releaseIo.err).toBe('');

    const checkIo = testIo(project);
    expect(await main(['check', 'HEAD', '--file', '--help'], checkIo)).toBe(0);
    expect(checkIo.out).toBe(CHECK_USAGE);
    expect(checkIo.err).toBe('');
  });

  test('the --json scan and the parse agree: --, an unknown option, and the forms without a package', async () => {
    /** The page's rule, written out independently: a `--json` that is the value of `--file` is a
     *  path; any other `--json` selects the JSON output. */
    function jsonByTheRule(argv: string[]): boolean {
      for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--file') index += 1;
        else if (argv[index] === '--json') return true;
      }
      return false;
    }

    const rows: { label: string; argv: string[]; json: boolean; code: 'configuration' | 'usage'; message: string }[] = [
      // The `--` beside --file stays a value when it is the option's turn, and is refused when it
      // is not; a free `--json` selects JSON, a consumed one cannot.
      { label: '--file -- --json', argv: ['check', 'material@3.0.2', '--file', '--', '--json'], json: true, code: 'configuration', message: `${join(project, '--')}: no team file at --` },
      { label: '--file --json --', argv: ['check', 'material@3.0.2', '--file', '--json', '--'], json: false, code: 'usage', message: 'unknown option --' },
      { label: '--bogus --file --json', argv: ['check', 'material@3.0.2', '--bogus', '--file', '--json'], json: false, code: 'usage', message: 'unknown option --bogus' },
      { label: 'no package: --file --json', argv: ['check', '--file', '--json'], json: false, code: 'usage', message: 'a <package@version> is required' },
      { label: 'no package: --file -- --json', argv: ['check', '--file', '--', '--json'], json: true, code: 'usage', message: 'a <package@version> is required' },
      { label: 'no package: --bogus --file --json', argv: ['check', '--bogus', '--file', '--json'], json: false, code: 'usage', message: 'unknown option --bogus' },
    ];
    for (const row of rows) {
      const { code, io, requested } = await run(row.argv, happy());
      expect({ label: row.label, code }).toEqual({ label: row.label, code: 2 });
      expect(requested).toEqual([]);
      if (row.json) {
        expect({ label: row.label, out: JSON.parse(io.out) }).toEqual({ label: row.label, out: errorDoc(`release.${row.code}`, row.message) });
        expect(io.err).toBe('');
      } else {
        expect({ label: row.label, err: io.err }).toEqual({ label: row.label, err: `team release: ${row.message}\n` });
        expect(io.out).toBe('');
      }
      // The shape above is what the parse did; this is what the scan says. They must match.
      expect({ label: row.label, json: jsonByTheRule(row.argv) }).toEqual({ label: row.label, json: row.json });
    }
  });
});

describe('the --file option is classified the same through both commands', () => {
  // `team commits check` parses its arguments with its own parser (src/commands/commits.ts), release parses
  // with the generic readArgs (src/args.ts) — the parsers are not shared, and this pins the two so
  // they cannot drift apart on `--file`: for every invocation the commands must take the same
  // value, or refuse with the same misuse and the same message shape. What they do share is the
  // load — loadTeamFile and the path resolution from src/file/load.ts — so the refusal's path is
  // spelled identically. Only the first refusal line is compared: check prints every problem of an
  // invalid file, release the first.
  /** One run's --file classification: the shared misuse, or the value it took, named by the
   *  refusal's own spelling; a run the file did not refuse is `past-the-loader`. */
  function classify(err: string, prefix: string): string {
    const message = (err.startsWith(prefix) ? err.slice(prefix.length) : err).split('\n')[0] ?? '';
    if (message === '--file needs a value') return 'needs-value';
    const unknown = message.match(/^unknown option (\S+)$/);
    if (unknown) return `unknown:${unknown[1]}`;
    const missing = message.match(/^(.+): no team file at (.+)$/);
    if (missing) return `no-file:${missing[1]}:${missing[2]}`;
    const invalid = message.match(/^(.+), line (\d+): (.+)$/);
    if (invalid) return `invalid:${invalid[1]}:${invalid[2]}:${invalid[3]}`;
    return 'past-the-loader';
  }

  test('the ten cases take the same value, or refuse with the same message', async () => {
    mkdirSync(join(project, 'sub'));
    writeFileSync(join(project, 'sub', 'bad.yaml'), 'format: 2\n');
    writeFileSync(join(project, 'bad.yaml'), 'format: 2\n');
    writeFileSync(join(project, 'ok.yaml'), TEAM);
    const home = mkdtempSync(join(tmpdir(), 'team-check-home-'));
    try {
      const rows: { label: string; tail: string[]; expected: string }[] = [
        { label: 'a missing value', tail: ['--file'], expected: 'needs-value' },
        { label: 'a value that looks like an option', tail: ['--file', '--json'], expected: `no-file:${join(project, '--json')}:--json` },
        { label: '--file=<path>', tail: ['--file=sub/bad.yaml'], expected: `invalid:${join(project, 'sub', 'bad.yaml')}:1:format must be 1: this version of team reads no other` },
        { label: '--file= (empty)', tail: ['--file='], expected: 'needs-value' },
        { label: 'the option twice', tail: ['--file', 'nope-one.yaml', '--file', 'nope-two.yaml'], expected: `no-file:${join(project, 'nope-two.yaml')}:nope-two.yaml` },
        { label: 'a relative path', tail: ['--file', 'sub/nope.yaml'], expected: `no-file:${join(project, 'sub', 'nope.yaml')}:sub/nope.yaml` },
        { label: 'an absolute path', tail: ['--file', join(project, 'nope.yaml')], expected: `no-file:${join(project, 'nope.yaml')}:${join(project, 'nope.yaml')}` },
        { label: 'a missing file', tail: ['--file', 'nope.yaml'], expected: `no-file:${join(project, 'nope.yaml')}:nope.yaml` },
        { label: 'an invalid file', tail: ['--file', 'bad.yaml'], expected: `invalid:${join(project, 'bad.yaml')}:1:format must be 1: this version of team reads no other` },
        { label: 'a file that loads', tail: ['--file', 'ok.yaml'], expected: 'past-the-loader' },
      ];
      const released: Record<string, string> = {};
      const throughCheck: Record<string, string> = {};
      for (const row of rows) {
        const releaseIo = testIo(project);
        // Only the loading row may reach the transport (as a recorded failure); every refusal
        // before it keeps the seam throwing, so an accidental request fails the test.
        const transport = row.label === 'a file that loads'
          ? () => Promise.resolve({ kind: 'transport' } as const)
          : (): never => {
              throw new Error('the transport was called');
            };
        await runRelease(['check', 'material@3.0.2', ...row.tail], releaseIo, transport);
        released[row.label] = classify(releaseIo.err, 'team release: ');

        const checkIo = testIo(project);
        await commits(['check', 'HEAD', ...row.tail], checkIo, (cwd, file) => loadConfig(cwd, file, home));
        throughCheck[row.label] = classify(checkIo.err, 'team commits check: ');
      }
      const expected = Object.fromEntries(rows.map((row) => [row.label, row.expected]));
      expect(throughCheck).toEqual(expected);
      expect(released).toEqual(expected);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
