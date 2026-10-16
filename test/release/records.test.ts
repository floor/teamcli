// The `linear` and `activity` checks of `team release check`, driven case by case from the
// specification against recorded answers. No real network request, no real key store: the fetch
// is the answer map, the key reader is a fake, and the distinctive key under test is searched
// for in everything the run produces.
import { describe, expect, test } from 'bun:test';
import { runChecks, timestampOf, type Outcome, type ReleaseResult } from '../../src/release/checks.ts';
import { keychainReader, keyOf, type KeyReader } from '../../src/release/keychain.ts';
import type { ReleaseDecl } from '../../src/file/sections/releases.ts';
import type { RequestOptions } from '../../src/release/http.ts';
import {
  KEY, MARKER_LINE, MATERIAL_RECORDS, PROJECT_ID, SERVICE, TAG_OBJECT, URLS, activityFile, fakeFetch, fixture, happyRecords,
  json, linearAnswer, tagObject, withAnswer, type Answers, type Recorded,
} from './world.ts';

const KEY_READER: KeyReader = () => Promise.resolve({ ok: true, key: KEY });

async function run(
  answers: Answers,
  options: { decl?: ReleaseDecl; keyReader?: KeyReader; caps?: { reads: number; attempts: number } } = {},
): Promise<{ result: ReleaseResult; requested: string[]; requests: Recorded[]; keyCalls: string[] }> {
  const { fetcher, requested, requests } = fakeFetch(answers);
  const keyCalls: string[] = [];
  const inner = options.keyReader ?? KEY_READER;
  const keyReader: KeyReader = async (service) => {
    keyCalls.push(service);
    return inner(service);
  };
  const result = await runChecks(options.decl ?? MATERIAL_RECORDS, '3.0.2', fetcher, { keyReader, caps: options.caps });
  return { result, requested, requests, keyCalls };
}

// The specification's GraphQL document, typed here independently of the source: a typo in the
// constant the command sends fails this test, not both.
const SPEC_QUERY = `query ReleaseRecords($projectId: String!, $first: Int!) {
  project(id: $projectId) {
    id
    archivedAt
    projectMilestones(first: $first, includeArchived: true) {
      nodes { name status }
      pageInfo { hasNextPage }
    }
    projectUpdates(first: $first, includeArchived: true) {
      nodes { createdAt archivedAt }
      pageInfo { hasNextPage }
    }
  }
}`;

function linearRequests(requests: Recorded[]): Recorded[] {
  return requests.filter((record) => record.url === URLS.linear);
}

describe('the Linear request', () => {
  test('the body is the specification\'s document and variables exactly, the method and headers as specified', async () => {
    const { requests } = await run(happyRecords());
    const sent = linearRequests(requests);
    expect(sent.length).toBe(1);
    const request = sent[0]?.request as RequestOptions;
    expect(request.method).toBe('POST');
    expect(Object.keys(request.headers).sort()).toEqual(['Authorization', 'Content-Type']);
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.headers.Authorization).toBe(KEY);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['query', 'variables']);
    expect(body.query).toBe(SPEC_QUERY);
    expect(body.variables).toEqual({ projectId: PROJECT_ID, first: 100 });
  });

  test('the host is the Linear host and nothing else; a redirect is not followed and carries no key', async () => {
    const { requests, result } = await run(withAnswer(happyRecords(), URLS.linear, json({}, 302)));
    for (const record of requests) {
      if (record.request !== undefined) expect(record.url).toBe(URLS.linear);
    }
    expect(linearRequests(requests).length).toBe(1);
    expect(result.linear).toEqual({ status: 'unknown', detail: 'Linear record could not be read' });
  });

  test('a retry replays the same request byte for byte, key in the one header again', async () => {
    for (const status of [408, 429, 500]) {
      const answers = withAnswer(happyRecords(), URLS.linear, [json({}, status), json(linearAnswer())]);
      const { result, requests } = await run(answers);
      const sent = linearRequests(requests);
      expect(sent.length).toBe(2);
      expect(sent[0]?.request).toEqual(sent[1]?.request);
      expect(result.linear?.status).toBe('pass');
    }
  });

  test('every other read of the run is a bare GET without headers', async () => {
    const { requests } = await run(happyRecords());
    for (const record of requests) {
      if (record.url !== URLS.linear) expect(record.request).toBeUndefined();
    }
  });
});

describe('the key under test appears nowhere but the one header', () => {
  // After each scenario everything the run produced is searched: the output rows are covered by
  // the command-level no-leak suite; here the recorded requests and the key reader's arguments.
  function assertNoLeak(requests: Recorded[], keyCalls: string[]): void {
    for (const service of keyCalls) expect(service).toBe(SERVICE);
    for (const record of requests) {
      expect(record.url).not.toContain(KEY);
      expect(record.request?.body ?? '').not.toContain(KEY);
      for (const [name, value] of Object.entries(record.request?.headers ?? {})) {
        expect(name).not.toContain(KEY);
        if (value.includes(KEY)) {
          expect(name).toBe('Authorization');
          expect(record.url).toBe(URLS.linear);
        }
      }
    }
  }

  test('all pass: exactly one request carries the key, in its one credential header', async () => {
    const { requests, keyCalls, result } = await run(happyRecords());
    expect(result.linear?.status).toBe('pass');
    expect(keyCalls).toEqual([SERVICE]);
    assertNoLeak(requests, keyCalls);
  });

  test('401, 403, 500 twice, a timeout, invalid JSON, a 200 with errors, a redirect', async () => {
    const scenarios: Answers[] = [
      withAnswer(happyRecords(), URLS.linear, json({}, 401)),
      withAnswer(happyRecords(), URLS.linear, json({}, 403)),
      withAnswer(happyRecords(), URLS.linear, [json({}, 500), json({}, 500)]),
      withAnswer(happyRecords(), URLS.linear, { kind: 'timeout' }),
      withAnswer(happyRecords(), URLS.linear, { kind: 'http', status: 200, body: `{"data": ${KEY}` }),
      withAnswer(happyRecords(), URLS.linear, { kind: 'undecodable', status: 200 }),
      withAnswer(happyRecords(), URLS.linear, json({ data: null, errors: [{ message: 'no such project' }] })),
      withAnswer(happyRecords(), URLS.linear, json({}, 302)),
    ];
    for (const answers of scenarios) {
      const { requests, keyCalls, result } = await run(answers);
      expect(result.linear).toEqual({ status: 'unknown', detail: 'Linear record could not be read' });
      assertNoLeak(requests, keyCalls);
    }
  });

  test('the key reader fails or returns an illegal key: no request is formed at all', async () => {
    const failing: KeyReader = () => Promise.resolve({ ok: false, reason: 'the lookup failed' });
    const empty: KeyReader = () => Promise.resolve({ ok: true, key: '' });
    const illegal: KeyReader = () => Promise.resolve({ ok: true, key: 'has space' });
    for (const keyReader of [failing, empty, illegal]) {
      const { result, requested, requests, keyCalls } = await run(happyRecords(), { keyReader });
      expect(result.linear).toEqual({ status: 'unknown', detail: 'Keychain access was unavailable' });
      expect(requested).not.toContain(URLS.linear);
      assertNoLeak(requests, keyCalls);
    }
  });

  test('a response body that itself contains the key string is not echoed into any request', async () => {
    const answer = linearAnswer({ milestones: [{ name: KEY, status: 'done' }] });
    const { result, requests, keyCalls } = await run(withAnswer(happyRecords(), URLS.linear, json(answer)));
    expect(result.linear).toEqual({ status: 'missing', detail: 'no matching Linear milestone found' });
    assertNoLeak(requests, keyCalls);
  });
});

describe('the linear check', () => {
  test('pass: one done milestone and a qualifying status update, the fixed detail', async () => {
    const { result } = await run(happyRecords());
    expect(result.linear).toEqual({ status: 'pass', detail: 'Linear milestone is complete and a qualifying status update exists' });
  });

  test('changelog unknown: unknown, the fixed detail, and no key is read and no request made', async () => {
    const answers = withAnswer(happyRecords(), URLS.changelog, [json({}, 500), json({}, 500)]);
    const { result, requested, keyCalls } = await run(answers);
    expect(result.changelog.status).toBe('unknown');
    expect(result.linear).toEqual({ status: 'unknown', detail: 'release date could not be read' });
    expect(keyCalls).toEqual([]);
    expect(requested).not.toContain(URLS.linear);
  });

  test('changelog missing: missing, the fixed detail, and no key is read and no request made', async () => {
    const answers = withAnswer(happyRecords(), URLS.changelog, json({}, 404));
    const { result, requested, keyCalls } = await run(answers);
    expect(result.changelog.status).toBe('missing');
    expect(result.linear).toEqual({ status: 'missing', detail: 'release date is missing from changelog' });
    expect(keyCalls).toEqual([]);
    expect(requested).not.toContain(URLS.linear);
  });

  test('an archived project is missing, with the fixed detail', async () => {
    const { result } = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ project: { archivedAt: '2026-09-01T00:00:00Z' } }))));
    expect(result.linear).toEqual({ status: 'missing', detail: 'configured Linear project is archived' });
  });

  test('a project archive state that is neither null nor a valid timestamp is an incomplete record', async () => {
    // Only two shapes are legal — null (not archived) and a valid timestamp string (archived,
    // the missing detail above). Anything else is malformed selected data: unknown, never
    // missing, whatever JSON type it arrived as.
    const shapes: [string, unknown][] = [
      ['a number', 7],
      ['a boolean', true],
      ['an array', []],
      ['an object', {}],
      ['an empty string', ''],
      ['a string that is not a timestamp', 'archived since 2026-09-01'],
      ['no key at all', undefined],
    ];
    for (const [shape, value] of shapes) {
      const { result } = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ project: { archivedAt: value } }))));
      expect([shape, result.linear]).toEqual([shape, { status: 'unknown', detail: 'Linear record is incomplete' }]);
    }
    // Null is the not-archived state: the well-formed answer still passes.
    const active = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ project: { archivedAt: null } }))));
    expect(active.result.linear?.status).toBe('pass');
  });

  test('the sibling sweep: no malformed shape of the answer can read as missing or pass', async () => {
    // Every field the Linear answer is read from, with wrong types, nulls, absent keys and empty
    // values — the two failure details are the only legal outcomes for these.
    const record: Outcome = { status: 'unknown', detail: 'Linear record is incomplete' };
    const unread: Outcome = { status: 'unknown', detail: 'Linear record could not be read' };
    const cases: [string, unknown, Outcome][] = [
      ['no data object', {}, unread],
      ['a data that is not an object', { data: 7 }, unread],
      ['a data that is an array', { data: [] }, unread],
      ['an errors key beside a data object', { data: {}, errors: [] }, unread],
      ['no project', { data: {} }, record],
      ['a project that is not an object', { data: { project: 7 } }, record],
      ['a project that is an array', { data: { project: [] } }, record],
      ['no project id', linearAnswer({ project: { id: undefined } }), record],
      ['a numeric project id', linearAnswer({ project: { id: 7 } }), record],
      ['an empty project id', linearAnswer({ project: { id: '' } }), record],
      ['no milestones relation', linearAnswer({ project: { projectMilestones: undefined } }), record],
      ['a milestones relation that is not an object', linearAnswer({ project: { projectMilestones: null } }), record],
      ['a milestones relation that is an array', linearAnswer({ project: { projectMilestones: [] } }), record],
      [
        'milestone nodes that are not an array',
        linearAnswer({ project: { projectMilestones: { nodes: {}, pageInfo: { hasNextPage: false } } } }),
        record,
      ],
      ['a milestone that is not an object', linearAnswer({ milestones: [null] }), record],
      ['a numeric milestone', linearAnswer({ milestones: [7] }), record],
      ['a numeric milestone name', linearAnswer({ milestones: [{ name: 3, status: 'done' }] }), record],
      ['a numeric milestone status', linearAnswer({ milestones: [{ name: '3.0.2', status: 7 }] }), record],
      ['no updates relation', linearAnswer({ project: { projectUpdates: undefined } }), record],
      ['an update that is not an object', linearAnswer({ updates: [null] }), record],
      ['a numeric createdAt', linearAnswer({ updates: [{ createdAt: 7, archivedAt: null }] }), record],
      ['an empty createdAt', linearAnswer({ updates: [{ createdAt: '', archivedAt: null }] }), record],
      ['an empty archivedAt', linearAnswer({ updates: [{ createdAt: '2026-10-01T12:00:00Z', archivedAt: '' }] }), record],
    ];
    for (const [shape, body, expected] of cases) {
      const { result } = await run(withAnswer(happyRecords(), URLS.linear, json(body)));
      expect([shape, result.linear]).toEqual([shape, expected]);
    }
  });

  test('a project whose id does not match, or no project at all, is an incomplete record', async () => {
    const wrong = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ project: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }))));
    expect(wrong.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });

    const answers = withAnswer(happyRecords(), URLS.linear, json({ data: { project: null } }));
    const none = await run(answers);
    expect(none.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });
  });

  test('zero matching milestones is missing; one not done is missing; two or more are unknown', async () => {
    const zero = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ milestones: [{ name: '3.0.1', status: 'done' }] }))));
    expect(zero.result.linear).toEqual({ status: 'missing', detail: 'no matching Linear milestone found' });

    const started = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ milestones: [{ name: '3.0.2', status: 'started' }] }))));
    expect(started.result.linear).toEqual({ status: 'missing', detail: 'matching Linear milestone is incomplete' });

    const two = await run(
      withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ milestones: [{ name: '3.0.2', status: 'done' }, { name: '3.0.2', status: 'started' }] }))),
    );
    expect(two.result.linear).toEqual({ status: 'unknown', detail: 'multiple matching Linear milestones found' });
  });

  test('a milestone the API returns participates even when its archivedAt is set', async () => {
    // The read asks for the archived records (includeArchived: true); milestones are not
    // excluded on archivedAt, so the one done match still satisfies the condition.
    const archived = await run(
      withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ milestones: [{ name: '3.0.2', status: 'done', archivedAt: '2026-09-01T00:00:00Z' }] }))),
    );
    expect(archived.result.linear).toEqual({ status: 'pass', detail: 'Linear milestone is complete and a qualifying status update exists' });
  });

  test('a milestone without a string name or status is an incomplete record, whatever the count', async () => {
    const noStatus = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ milestones: [{ name: '3.0.2' }] }))));
    expect(noStatus.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });

    const noName = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ milestones: [{ status: 'done' }] }))));
    expect(noName.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });
  });

  test('a next page of milestones or of updates is an incomplete record, and no second page is read', async () => {
    const milestones = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ milestonesPageInfo: { hasNextPage: true } }))));
    expect(milestones.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });

    const updates = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updatesPageInfo: { hasNextPage: true } }))));
    expect(updates.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });

    for (const malformed of [{ hasNextPage: 'false' }, {}, null]) {
      const { result } = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updatesPageInfo: malformed as Record<string, unknown> }))));
      expect(result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });
    }
    // One read only: the URL is requested once, never with an after cursor.
    expect(linearRequests(milestones.requests).length).toBe(1);
  });

  test('an update exactly at the release date 00:00:00Z qualifies; one second before does not', async () => {
    const exact = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ createdAt: '2026-10-01T00:00:00Z', archivedAt: null }] }))));
    expect(exact.result.linear?.status).toBe('pass');

    const before = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ createdAt: '2026-09-30T23:59:59Z', archivedAt: null }] }))));
    expect(before.result.linear).toEqual({ status: 'missing', detail: 'no qualifying Linear status update found' });
  });

  test('an offset instant is compared as an instant: +02:00 at 01:00 is the previous day', async () => {
    const answers = withAnswer(
      happyRecords(),
      URLS.linear,
      json(linearAnswer({ updates: [{ createdAt: '2026-10-01T01:00:00+02:00', archivedAt: null }] })),
    );
    const { result } = await run(answers);
    expect(result.linear).toEqual({ status: 'missing', detail: 'no qualifying Linear status update found' });

    const future = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ createdAt: '2027-01-01T00:00:00Z', archivedAt: null }] }))));
    expect(future.result.linear?.status).toBe('pass');
  });

  test('archived updates do not participate; an invalid timestamp or archive state is incomplete', async () => {
    const archived = await run(
      withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ createdAt: '2026-10-02T00:00:00Z', archivedAt: '2026-10-03T00:00:00Z' }] }))),
    );
    expect(archived.result.linear).toEqual({ status: 'missing', detail: 'no qualifying Linear status update found' });

    const badCreated = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ createdAt: '2026-10-01 12:00:00Z', archivedAt: null }] }))));
    expect(badCreated.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });

    const noCreated = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ archivedAt: null }] }))));
    expect(noCreated.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });

    const noArchive = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ createdAt: '2026-10-01T12:00:00Z' }] }))));
    expect(noArchive.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });

    const badArchive = await run(withAnswer(happyRecords(), URLS.linear, json(linearAnswer({ updates: [{ createdAt: '2026-10-01T12:00:00Z', archivedAt: 7 }] }))));
    expect(badArchive.result.linear).toEqual({ status: 'unknown', detail: 'Linear record is incomplete' });
  });

  test('simultaneous conditions: the detail is the first applicable row, the status stays unknown', async () => {
    // An archived project (missing) with an unreadable updates page extent (unknown): the table
    // puts the archived row first, and the precedence keeps the status unknown.
    const answers = withAnswer(
      happyRecords(),
      URLS.linear,
      json(linearAnswer({ project: { archivedAt: '2026-09-01T00:00:00Z' }, updatesPageInfo: { hasNextPage: true } })),
    );
    const { result } = await run(answers);
    expect(result.linear).toEqual({ status: 'unknown', detail: 'configured Linear project is archived' });
  });

  test('no key reader wired is the Keychain failure, and no request is made', async () => {
    const { fetcher, requested } = fakeFetch(happyRecords());
    const result = await runChecks(MATERIAL_RECORDS, '3.0.2', fetcher, {});
    expect(result.linear).toEqual({ status: 'unknown', detail: 'Keychain access was unavailable' });
    expect(requested).not.toContain(URLS.linear);
  });

  test('the key reader is called at most once, with the configured service', async () => {
    const { keyCalls } = await run(happyRecords());
    expect(keyCalls).toEqual([SERVICE]);
  });
});

describe('the activity check', () => {
  test('pass: exactly one marker line, with the fixed detail', async () => {
    const { result } = await run(happyRecords());
    expect(result.activity).toEqual({ status: 'pass', detail: 'public activity marker found' });
  });

  test('zero marker lines is missing; two or more are unknown', async () => {
    const zero = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile('# Activity\n\nnothing here.\n'))));
    expect(zero.result.activity).toEqual({ status: 'missing', detail: 'public activity marker is missing' });

    const two = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile(`${MARKER_LINE}\ntext\n${MARKER_LINE}\n`))));
    expect(two.result.activity).toEqual({ status: 'unknown', detail: 'multiple public activity markers found' });
  });

  test('lines split on LF or CRLF; trailing whitespace is data; a final delimiter adds no line', async () => {
    const crlf = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile(`one\r\n${MARKER_LINE}\r\n`))));
    expect(crlf.result.activity?.status).toBe('pass');

    const unterminated = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile(`one\n${MARKER_LINE}`))));
    expect(unterminated.result.activity?.status).toBe('pass');

    const trailingSpace = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile(`${MARKER_LINE} \n`))));
    expect(trailingSpace.result.activity?.status).toBe('missing');

    const loneCarriageReturn = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile(`${MARKER_LINE}\rtext\n`))));
    expect(loneCarriageReturn.result.activity?.status).toBe('missing');

    // "marker\n\n" is two lines — the marker and an empty one — not three.
    const blankAfter = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile(`${MARKER_LINE}\n\n`))));
    expect(blankAfter.result.activity?.status).toBe('pass');
  });

  test('a 404 is missing; an uninterpretable object or a failed read is unknown', async () => {
    const missing = await run(withAnswer(happyRecords(), URLS.activity, json({}, 404)));
    expect(missing.result.activity).toEqual({ status: 'missing', detail: 'public activity marker is missing' });

    const dir = await run(withAnswer(happyRecords(), URLS.activity, json({ ...activityFile('x'), type: 'dir' })));
    expect(dir.result.activity).toEqual({ status: 'unknown', detail: 'public activity file could not be read' });

    const badBase64 = await run(withAnswer(happyRecords(), URLS.activity, json({ ...activityFile('x'), content: '!!!' })));
    expect(badBase64.result.activity).toEqual({ status: 'unknown', detail: 'public activity file could not be read' });

    // Valid base64 whose bytes are not valid UTF-8: never repaired into a replacement character.
    const badUtf8 = await run(
      withAnswer(happyRecords(), URLS.activity, json({ ...activityFile('x'), content: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64') })),
    );
    expect(badUtf8.result.activity).toEqual({ status: 'unknown', detail: 'public activity file could not be read' });

    const failed = await run(withAnswer(happyRecords(), URLS.activity, [json({}, 500), json({}, 500)]));
    expect(failed.result.activity).toEqual({ status: 'unknown', detail: 'public activity file could not be read' });

    const tooLarge = await run(withAnswer(happyRecords(), URLS.activity, { kind: 'too-large', status: 200, prefix: '' }));
    expect(tooLarge.result.activity).toEqual({ status: 'unknown', detail: 'public activity file could not be read' });
  });

  test('the sibling sweep: no malformed contents shape can read as missing or pass', async () => {
    // Every field the activity answer is read from, with wrong types, absent keys and empty
    // values. An empty file is the one legal answer that is missing: it names no marker.
    const unread: Outcome = { status: 'unknown', detail: 'public activity file could not be read' };
    const cases: [string, unknown][] = [
      ['no type', { ...activityFile('x'), type: undefined }],
      ['a type that is not file', { ...activityFile('x'), type: 'blob' }],
      ['an empty type', { ...activityFile('x'), type: '' }],
      ['no encoding', { ...activityFile('x'), encoding: undefined }],
      ['an encoding that is not base64', { ...activityFile('x'), encoding: 'utf-8' }],
      ['no content', { ...activityFile('x'), content: undefined }],
      ['a numeric content', { ...activityFile('x'), content: 7 }],
    ];
    for (const [shape, body] of cases) {
      const { result } = await run(withAnswer(happyRecords(), URLS.activity, json(body)));
      expect([shape, result.activity]).toEqual([shape, unread]);
    }
    const empty = await run(withAnswer(happyRecords(), URLS.activity, json(activityFile(''))));
    expect(empty.result.activity).toEqual({ status: 'missing', detail: 'public activity marker is missing' });
  });

  test('a missing repository makes the activity read not required; an unknown one makes it unknown', async () => {
    const missing = await run(withAnswer(happyRecords(), URLS.repo, json({}, 404)));
    expect(missing.result.activity).toEqual({ status: 'missing', detail: 'public activity marker is missing' });
    expect(missing.requested).not.toContain(URLS.activity);

    const unknown = await run(withAnswer(happyRecords(), URLS.repo, [json({}, 500), json({}, 500)]));
    expect(unknown.result.activity).toEqual({ status: 'unknown', detail: 'public activity file could not be read' });
    expect(unknown.requested).not.toContain(URLS.activity);
  });
});

describe('the budget with the two reads added', () => {
  test('the maximal configured run is fourteen reads and twenty-eight attempts, each once retried', async () => {
    // Every endpoint of a full configured run — trusted publishing, the dist-tags document, a
    // chain of four tag objects, the Linear and activity reads — each answered 500 then 200:
    // fourteen reads, two attempts.
    const shas = ['b', 'c', 'd', 'e'].map((letter) => letter.repeat(40));
    const chain = [TAG_OBJECT, ...shas];
    const ok = new Map<string, Record<string, unknown>>([
      [URLS.npm, fixture('npm-version.json')],
      [URLS.attest, fixture('npm-attestations.json')],
      [URLS.tags, { latest: '3.0.2', next: '3.0.2' }],
      [URLS.repo, fixture('github-repo.json')],
      [URLS.ref, fixture('github-tag-ref-annotated.json')],
      [URLS.release, fixture('github-release.json')],
      [URLS.changelog, fixture('github-contents.json')],
      [URLS.activity, activityFile(`${MARKER_LINE}\n`)],
      [URLS.linear, linearAnswer()],
      [`https://api.github.com/repos/floor/material/compare/${shas[3]}...main`, fixture('github-compare.json')],
    ]);
    for (let index = 0; index < 4; index++) {
      const at = chain[index] as string;
      ok.set(`https://api.github.com/repos/floor/material/git/tags/${at}`, tagObject(at, chain[index + 1] as string, index === 3 ? 'commit' : 'tag'));
    }
    const urls = [...ok.keys()];
    const answers: Answers = new Map(urls.map((url) => [url, [json({}, 500), json(ok.get(url) as Record<string, unknown>)]]));
    const { result, requested } = await run(answers);
    expect(new Set(requested)).toEqual(new Set(urls));
    expect(urls.length).toBe(14);
    expect(requested.length).toBe(28);
    expect(result.warning).toBeUndefined();
    for (const outcome of Object.values(result)) if (typeof outcome !== 'string') expect(outcome.status).toBe('pass');
  });

  test('a cap that prevents the Linear or activity read makes that check unknown, and the key is never read', async () => {
    // Eight reads cover everything before the two new ones in a passing run's shape (npm, attest,
    // tags, repo, ref, compare, release, changelog = 8; the ninth would be Linear's). The exhausted
    // read cap is a non-secret prerequisite: the budget cannot make the request, so the Keychain
    // must not be touched at all — zero key-reader calls, zero Linear requests.
    const { result, requested, keyCalls } = await run(happyRecords(), { caps: { reads: 8, attempts: 28 } });
    expect(keyCalls).toEqual([]);
    expect(requested).not.toContain(URLS.linear);
    expect(requested).not.toContain(URLS.activity);
    expect(result.linear).toEqual({ status: 'unknown', detail: 'Linear record could not be read' });
    expect(result.activity).toEqual({ status: 'unknown', detail: 'public activity file could not be read' });
  });

  test('an exhausted attempt cap stops the Linear read before the key is read', async () => {
    // The read cap still allows the read, but every attempt the run could make is already spent:
    // the request cannot be sent, so the Keychain is not read — zero calls, zero requests.
    const { result, requested, keyCalls } = await run(happyRecords(), { caps: { reads: 13, attempts: 8 } });
    expect(keyCalls).toEqual([]);
    expect(requested).not.toContain(URLS.linear);
    expect(result.linear).toEqual({ status: 'unknown', detail: 'Linear record could not be read' });
  });
});

describe('the Keychain reader', () => {
  const runSecurityOk = (stdout: string) => () => Promise.resolve({ ok: true as const, stdout });

  test('a platform without the facility is unavailable, and the lookup is never invoked', async () => {
    let called = false;
    const reader = keychainReader('linux', true, () => {
      called = true;
      return Promise.resolve({ ok: false });
    });
    expect(await reader(SERVICE)).toEqual({ ok: false, reason: 'this platform has no such facility' });
    expect(called).toBe(false);
  });

  test('a non-interactive run does not invoke the lookup', async () => {
    let called = false;
    const reader = keychainReader('darwin', false, () => {
      called = true;
      return Promise.resolve({ ok: false });
    });
    expect(await reader(SERVICE)).toEqual({ ok: false, reason: 'the run is not interactive' });
    expect(called).toBe(false);
  });

  test('a failed lookup is unavailable, generically', async () => {
    const reader = keychainReader('darwin', true, () => Promise.resolve({ ok: false }));
    expect(await reader(SERVICE)).toEqual({ ok: false, reason: 'the lookup failed' });
  });

  test('the service name is the only argument the lookup ever gets', async () => {
    const seen: string[] = [];
    const reader = keychainReader('darwin', true, (service) => {
      seen.push(service);
      return Promise.resolve({ ok: true as const, stdout: `${KEY}\n` });
    });
    expect(await reader(SERVICE)).toEqual({ ok: true, key: KEY });
    expect(seen).toEqual([SERVICE]);
    expect(seen.join('')).not.toContain(KEY);
  });

  test('the output rule: one trailing line feed removed, then printable ASCII only', async () => {
    expect(await keychainReader('darwin', true, runSecurityOk(`${KEY}\n`))(SERVICE)).toEqual({ ok: true, key: KEY });
    // No trailing line feed is fine; two feeds leave one, which is not a legal key byte.
    expect(await keychainReader('darwin', true, runSecurityOk(KEY))(SERVICE)).toEqual({ ok: true, key: KEY });
    expect((await keychainReader('darwin', true, runSecurityOk(`${KEY}\n\n`))(SERVICE)).ok).toBe(false);
  });
});

describe('the key bytes', () => {
  test('one or more ASCII bytes 0x21 through 0x7e', () => {
    expect(keyOf('!')).toEqual({ ok: true, key: '!' });
    expect(keyOf('~')).toEqual({ ok: true, key: '~' });
    expect(keyOf(KEY)).toEqual({ ok: true, key: KEY });
    expect(keyOf('').ok).toBe(false);
    expect(keyOf('\n').ok).toBe(false);
    expect(keyOf('has space').ok).toBe(false);
    expect(keyOf('tab\tkey').ok).toBe(false);
    expect(keyOf('é').ok).toBe(false);
    expect(keyOf('del\x7f').ok).toBe(false);
    expect(keyOf(`${KEY}\n`)).toEqual({ ok: true, key: KEY });
    expect(keyOf(`${KEY}\r\n`).ok).toBe(false);
  });
});

describe('the timestamp grammar', () => {
  const RELEASE_AT = Date.UTC(2026, 9, 1);

  test('accepted instants compare as instants', () => {
    expect(timestampOf('2026-10-01T00:00:00Z')).toBe(RELEASE_AT);
    expect(timestampOf('2026-10-01T02:00:00+02:00')).toBe(RELEASE_AT);
    expect(timestampOf('2026-10-01T00:00:00.000000001Z')).toBe(RELEASE_AT);
    expect(timestampOf('2026-09-30T20:00:00-04:00')).toBe(RELEASE_AT);
    expect(timestampOf('2026-10-01T00:00:01Z')).toBe(RELEASE_AT + 1000);
  });

  test('refused forms read as no instant', () => {
    for (const text of [
      '2026-10-01',
      '2026-10-01T00:00:00',
      '2026-10-01t00:00:00z',
      '2026-10-01T00:00Z',
      '2026-10-01T00:00:00+0200',
      '2026-10-01T00:00:00+24:00',
      '2026-10-01T00:00:00.0000000001Z',
      '2026-10-01T00:00:60Z',
      '2026-02-30T00:00:00Z',
      '2026-10-00T00:00:00Z', // day 00 is not a date; it must not roll back into September
      '2026-00-01T00:00:00Z',
      '2026-10-01T24:00:00Z',
      ' 2026-10-01T00:00:00Z',
      0,
    ]) {
      expect(timestampOf(text as string)).toBeNull();
    }
  });
});
