// The four checks of `team release check`, driven from the specification's own cases against
// recorded answers. No real network request is ever made: the fetch is the answer map.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, encodeSegment, retried, type ReleaseResult } from '../../src/release/checks.ts';
import type { ReleaseDecl } from '../../src/file/sections/releases.ts';
import {
  COMMIT, MATERIAL, TAG_OBJECT, URLS, changelog, fakeFetch, fixture, happy, json, tagObject, withAnswer, withChange,
  type Answers,
} from './world.ts';

async function run(
  answers: Answers,
  decl: ReleaseDecl = MATERIAL,
  version = '3.0.2',
  caps?: { reads: number; attempts: number },
): Promise<{ result: ReleaseResult; requested: string[] }> {
  const { fetcher, requested } = fakeFetch(answers);
  return { result: await runChecks(decl, version, fetcher, { caps }), requested };
}

describe('the npm check', () => {
  test('pass without trusted publishing: exact version and checksums, no attestation read', async () => {
    const { result, requested } = await run(happy(false), { ...MATERIAL, trustedPublishing: false });
    expect(result.npm).toEqual({ status: 'pass', detail: 'exact version and checksums found' });
    expect(requested).not.toContain(URLS.attest);
  });

  test('pass with trusted publishing: the fixed detail', async () => {
    const { result } = await run(happy());
    expect(result.npm).toEqual({ status: 'pass', detail: 'exact version, checksums, and provenance found' });
  });

  test('a 404 on the version record is missing, and the attestation read is still made', async () => {
    const { result, requested } = await run(withAnswer(happy(), URLS.npm, json({}, 404)));
    expect(result.npm.status).toBe('missing');
    expect(result.npm.detail).toBe('npm has no material@3.0.2');
    expect(requested).toContain(URLS.npm);
    expect(requested).toContain(URLS.attest);
  });

  test('a record for another name or version is unknown', async () => {
    for (const change of [{ name: 'other' }, { version: '3.0.3' }, { name: 3 }]) {
      const { result } = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, ...change })));
      expect(result.npm.status).toBe('unknown');
    }
  });

  test('an absent dist is missing; a non-object dist is unknown', async () => {
    const missing = await run(withChange(happy(), URLS.npm, ({ dist: _dist, ...rest }) => rest));
    expect(missing.result.npm).toEqual({ status: 'missing', detail: 'the npm record has no dist' });
    const unknown = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, dist: 'x' })));
    expect(unknown.result.npm.status).toBe('unknown');
  });

  test('an absent or empty checksum is missing; a non-string one is unknown', async () => {
    const absent = await run(withChange(happy(), URLS.npm, (value) => {
      const dist = value.dist as Record<string, unknown>;
      return { ...value, dist: { integrity: dist.integrity } };
    }));
    expect(absent.result.npm).toEqual({ status: 'missing', detail: 'the npm record has no dist.shasum' });

    const empty = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, dist: { ...(value.dist as object), shasum: '' } })));
    expect(empty.result.npm).toEqual({ status: 'missing', detail: 'the npm record has an empty dist.shasum' });

    const nonString = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, dist: { ...(value.dist as object), shasum: 42 } })));
    expect(nonString.result.npm).toEqual({ status: 'unknown', detail: 'dist.shasum is not a string' });

    const integrity = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, dist: { ...(value.dist as object), integrity: undefined } })));
    expect(integrity.result.npm).toEqual({ status: 'missing', detail: 'the npm record has no dist.integrity' });
  });

  test('a null dist, or a null checksum, is unknown: present but not the right type', async () => {
    const nullDist = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, dist: null })));
    expect(nullDist.result.npm).toEqual({ status: 'unknown', detail: "the npm record's dist is not an object" });

    const nullShasum = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, dist: { ...(value.dist as object), shasum: null } })));
    expect(nullShasum.result.npm).toEqual({ status: 'unknown', detail: 'dist.shasum is not a string' });

    const nullIntegrity = await run(withChange(happy(), URLS.npm, (value) => ({ ...value, dist: { ...(value.dist as object), integrity: null } })));
    expect(nullIntegrity.result.npm).toEqual({ status: 'unknown', detail: 'dist.integrity is not a string' });
  });

  test('every checksum field is examined: unknown beats missing across fields', async () => {
    // An absent shasum is missing, but the numeric integrity is present and malformed, and
    // unknown beats missing — deciding on the first field would report the wrong status.
    const { result } = await run(withChange(happy(), URLS.npm, () => ({ ...fixture('npm-version.json'), dist: { integrity: 42 } })));
    expect(result.npm).toEqual({ status: 'unknown', detail: 'dist.integrity is not a string' });
  });

  test('attestations: an empty array or no provenance entry is missing', async () => {
    const empty = await run(withChange(happy(), URLS.attest, () => ({ attestations: [] })));
    expect(empty.result.npm).toEqual({ status: 'missing', detail: 'npm shows no provenance attestation for this version' });

    const other = await run(withChange(happy(), URLS.attest, () => ({ attestations: [{ predicateType: 'https://example.test/other' }] })));
    expect(other.result.npm.status).toBe('missing');

    const absent = await run(withChange(happy(), URLS.attest, () => ({})));
    expect(absent.result.npm).toEqual({ status: 'unknown', detail: 'the attestation response has no attestations list' });

    const malformed = await run(withChange(happy(), URLS.attest, () => ({ attestations: 'yes' })));
    expect(malformed.result.npm.status).toBe('unknown');
  });

  test('a 404 on the attestation endpoint is missing', async () => {
    const { result } = await run(withAnswer(happy(), URLS.attest, json({}, 404)));
    expect(result.npm.status).toBe('missing');
  });

  test('an entry that is not an object does not count, but one provenance entry is enough', async () => {
    const { result } = await run(withChange(happy(), URLS.attest, () => ({
      attestations: ['junk', { predicateType: 'https://slsa.dev/provenance/v1' }],
    })));
    expect(result.npm.status).toBe('pass');
  });

  test('invalid JSON is unknown', async () => {
    const answers = happy();
    answers.set(URLS.npm, { kind: 'http', status: 200, body: 'not json' });
    const { result } = await run(answers);
    expect(result.npm.status).toBe('unknown');
  });

  test('an unknown version record wins over a missing attestation', async () => {
    const answers = withAnswer(happy(), URLS.npm, json({}, 500));
    answers.set(URLS.npm, [json({}, 500), json({}, 500)]);
    withAnswer(answers, URLS.attest, json({ attestations: [] }));
    const { result } = await run(answers);
    expect(result.npm.status).toBe('unknown');
  });
});

describe('the tag check', () => {
  test('a lightweight tag with compare ahead or identical passes', async () => {
    for (const status of ['ahead', 'identical']) {
      const { result } = await run(withChange(happy(), URLS.compare, (value) => ({ ...value, status })));
      expect(result.tag).toEqual({ status: 'pass', detail: 'tag resolves to a commit on the default branch' });
    }
  });

  test('compare behind or diverged is missing, with the fixed detail', async () => {
    for (const status of ['behind', 'diverged']) {
      const { result } = await run(withChange(happy(), URLS.compare, (value) => ({ ...value, status })));
      expect(result.tag).toEqual({ status: 'missing', detail: 'tag commit is not an ancestor of the default branch' });
    }
  });

  test('an annotated tag resolves through one tag object', async () => {
    const answers = withChange(happy(), URLS.ref, () => fixture('github-tag-ref-annotated.json'));
    answers.set(URLS.tagObject, json(fixture('github-tag-object.json')));
    const { result, requested } = await run(answers);
    expect(result.tag.status).toBe('pass');
    expect(requested).toContain(URLS.tagObject);
  });

  test('an annotated tag resolves through four tag objects', async () => {
    const shas = ['b', 'c', 'd', 'e'].map((letter) => letter.repeat(40));
    const answers = withChange(happy(), URLS.ref, () => fixture('github-tag-ref-annotated.json'));
    const chain = [TAG_OBJECT, ...shas];
    for (let index = 0; index < 4; index++) {
      const at = chain[index] as string;
      const next = chain[index + 1] as string;
      answers.set(`https://api.github.com/repos/floor/material/git/tags/${at}`, json(tagObject(at, next, index === 3 ? 'commit' : 'tag')));
    }
    answers.delete(URLS.compare);
    answers.set(`https://api.github.com/repos/floor/material/compare/${shas[3]}...main`, json(fixture('github-compare.json')));
    const { result, requested } = await run(answers);
    expect(result.tag.status).toBe('pass');
    expect(requested.filter((url) => url.includes('/git/tags/')).length).toBe(4);
  });

  test('a fifth required hop is unknown, and is not requested', async () => {
    const shas = ['b', 'c', 'd', 'e', 'f'].map((letter) => letter.repeat(40));
    const answers = withChange(happy(), URLS.ref, () => fixture('github-tag-ref-annotated.json'));
    const chain = [TAG_OBJECT, ...shas];
    for (let index = 0; index < 4; index++) {
      const at = chain[index] as string;
      answers.set(`https://api.github.com/repos/floor/material/git/tags/${at}`, json(tagObject(at, chain[index + 1] as string, 'tag')));
    }
    const { result, requested } = await run(answers);
    expect(result.tag).toEqual({ status: 'unknown', detail: 'the tag chain needs a fifth tag object' });
    expect(requested).not.toContain(`https://api.github.com/repos/floor/material/git/tags/${shas[3]}`);
  });

  test('a non-commit target is missing, and the compare is not requested', async () => {
    const { result, requested } = await run(withChange(happy(), URLS.ref, (value) => ({
      ...value,
      object: { ...(value.object as object), type: 'tree' },
    })));
    expect(result.tag).toEqual({ status: 'missing', detail: 'the tag does not resolve to a commit' });
    expect(requested).not.toContain(URLS.compare);
  });

  test('an empty, non-hex or wrong-length tag SHA is unknown, and no compare request is formed', async () => {
    for (const sha of ['', 'xyz123', COMMIT.slice(0, 39), 'A'.repeat(40)]) {
      const { result, requested } = await run(withChange(happy(), URLS.ref, (value) => ({
        ...value,
        object: { ...(value.object as object), sha },
      })));
      expect(result.tag).toEqual({ status: 'unknown', detail: 'the tag could not be read' });
      expect(requested.filter((url) => url.includes('/compare/'))).toEqual([]);
    }
  });

  test('an empty or malformed SHA in an annotated tag object is unknown, and no compare is requested', async () => {
    for (const sha of ['', 'not-a-sha']) {
      const answers = withChange(happy(), URLS.ref, () => fixture('github-tag-ref-annotated.json'));
      answers.set(URLS.tagObject, json(tagObject(TAG_OBJECT, sha, 'commit')));
      const { result, requested } = await run(answers);
      expect(result.tag).toEqual({ status: 'unknown', detail: 'a tag object could not be read' });
      expect(requested.filter((url) => url.includes('/compare/'))).toEqual([]);
    }
  });

  test('a 404 on the ref is missing, and no downstream tag read is requested', async () => {
    const { result, requested } = await run(withAnswer(happy(), URLS.ref, json({}, 404)));
    expect(result.tag).toEqual({ status: 'missing', detail: 'GitHub has no tag v3.0.2' });
    expect(requested).toEqual([URLS.npm, URLS.attest, URLS.tags, URLS.repo, URLS.ref, URLS.release, URLS.changelog]);
  });

  test('a tag object 404 is missing', async () => {
    const answers = withChange(happy(), URLS.ref, () => fixture('github-tag-ref-annotated.json'));
    answers.set(URLS.tagObject, json({}, 404));
    const { result } = await run(answers);
    expect(result.tag.status).toBe('missing');
  });

  test('a malformed ref or tag object is unknown', async () => {
    const ref = await run(withChange(happy(), URLS.ref, () => ({ ref: 'refs/tags/v3.0.2' })));
    expect(ref.result.tag.status).toBe('unknown');

    const answers = withChange(happy(), URLS.ref, () => fixture('github-tag-ref-annotated.json'));
    answers.set(URLS.tagObject, json({ sha: TAG_OBJECT }));
    const object = await run(answers);
    expect(object.result.tag.status).toBe('unknown');
  });

  test('a compare 404 is missing; an unexpected or non-string status is unknown', async () => {
    const missing = await run(withAnswer(happy(), URLS.compare, json({}, 404)));
    expect(missing.result.tag.status).toBe('missing');

    const unexpected = await run(withChange(happy(), URLS.compare, () => ({ status: 'sideways' })));
    expect(unexpected.result.tag.status).toBe('unknown');

    const nonString = await run(withChange(happy(), URLS.compare, () => ({ status: 3 })));
    expect(nonString.result.tag.status).toBe('unknown');
  });

  test('an over-limit compare body reads its status from the head the fetch kept', async () => {
    // A compare of a tag far behind main runs over a megabyte of commit and file lists, but the
    // compare's own `status` sits near the head: measured 2026-10-07 on floor/teamcli's 06e01b8...main
    // compare, "status" at byte 14,398 of a 1,161,071-byte body (ahead_by 91). The fetch keeps the
    // head of an over-limit body, so this row reads its status without ever reading the diff.
    const head = '{"url":"https://api.github.com/repos/floor/teamcli/compare/06e01b8...main",'
      + '"html_url":"https://github.com/floor/teamcli/compare/06e01b8...main","permalink_url":"x",'
      + '"diff_url":"x.diff","patch_url":"x.patch",'
      + '"base_commit":{"sha":"a","node_id":"n","commit":{"message":"a { brace ] and a \\"quote\\"","tree":{"sha":"t"}}},'
      + '"merge_base_commit":{"sha":"a","commit":{"message":"older"}},'
      + '"status":"ahead","ahead_by":91,"behind_by":0,"total_commits":91,"commits":[{"sha":"b"';
    const { result } = await run(withAnswer(happy(), URLS.compare, { kind: 'too-large', status: 200, prefix: head }));
    expect(result.tag).toEqual({ status: 'pass', detail: 'tag resolves to a commit on the default branch' });

    const behind = await run(withAnswer(happy(), URLS.compare, {
      kind: 'too-large', status: 200, prefix: '{"url":"x","status":"behind","ahead_by":0',
    }));
    expect(behind.result.tag).toEqual({ status: 'missing', detail: 'tag commit is not an ancestor of the default branch' });
  });

  test('only the top-level status is read: nested and escaped decoys are skipped', async () => {
    // The head walker reads one top-level JSON string value: a commit message quoting
    // "status":"sideways", a nested object's own status, a number and a literal before it — all
    // walked past — and an escaped key is read as written, so it is never the compare's status.
    const head = '{"ahead_by":0,"draft":false,"pre":null,'
      + '"base_commit":{"status":"diverged","commit":{"message":"he said \\"status\\":\\"sideways\\""}},'
      + '"status":"ahead","behind_by":0';
    const { result } = await run(withAnswer(happy(), URLS.compare, { kind: 'too-large', status: 200, prefix: head }));
    expect(result.tag.status).toBe('pass');

    const escaped = await run(withAnswer(happy(), URLS.compare, {
      kind: 'too-large', status: 200, prefix: '{"st\\u0061tus":"ahead","status":"diverged"',
    }));
    expect(escaped.result.tag.status).toBe('missing');
  });

  test('an over-limit head that holds no readable status is unknown', async () => {
    const cases = [
      '{"base_commit":{"sha":"a","commit":{"message":"cut', // cut inside a string
      '{"status":"ahe', // cut inside the value
      '{"url":"x"}', // the whole object, and no status in it
      '{"base_commit":{"status":"ahead"}', // nested only, then cut
      '{"a":[},"status":"ahead"', // malformed: the brackets do not match
    ];
    for (const prefix of cases) {
      const { result } = await run(withAnswer(happy(), URLS.compare, { kind: 'too-large', status: 200, prefix }));
      expect(result.tag).toEqual({ status: 'unknown', detail: 'the compare could not be read' });
    }
  });

  test('a compare that is not a success, invalid, or over-limit with a failure status is unknown', async () => {
    const invalid = await run(withAnswer(happy(), URLS.compare, { kind: 'http', status: 200, body: 'not json' }));
    expect(invalid.result.tag).toEqual({ status: 'unknown', detail: 'the compare could not be read' });

    const redirect = await run(withAnswer(happy(), URLS.compare, json({}, 302)));
    expect(redirect.result.tag.status).toBe('unknown');

    // A failure status's head is not trusted: the response was never a success to begin with.
    const overLimitFailure = await run(withAnswer(happy(), URLS.compare, [
      { kind: 'too-large', status: 503, prefix: '{"status":"ahead"' },
      { kind: 'too-large', status: 503, prefix: '{"status":"ahead"' },
    ]));
    expect(overLimitFailure.result.tag.status).toBe('unknown');
  });

  test('a repository 404 makes tag and changelog missing, and the compare is not requested', async () => {
    const { result, requested } = await run(withAnswer(happy(), URLS.repo, json({}, 404)));
    expect(result.tag).toEqual({ status: 'missing', detail: 'GitHub has no repository floor/material' });
    expect(result.changelog.status).toBe('missing');
    expect(requested).toEqual([URLS.npm, URLS.attest, URLS.tags, URLS.repo, URLS.ref, URLS.release]);
  });

  test('a repository record without a default branch is unknown for tag and changelog', async () => {
    const { result } = await run(withChange(happy(), URLS.repo, () => ({ id: 1 })));
    expect(result.tag.status).toBe('unknown');
    expect(result.changelog.status).toBe('unknown');
  });

  test('an unknown repository read wins over a missing ref', async () => {
    const answers = withAnswer(happy(), URLS.ref, json({}, 404));
    answers.set(URLS.repo, [json({}, 500), json({}, 500)]);
    const { result } = await run(answers);
    expect(result.tag.status).toBe('unknown');
  });
});

describe('the github check', () => {
  test('pass: a published release whose prerelease flag matches the version', async () => {
    const { result } = await run(happy());
    expect(result.github).toEqual({ status: 'pass', detail: 'published release matches SemVer channel' });
  });

  test('pass: a prerelease version with a prerelease release', async () => {
    const version = '1.0.0-alpha.1';
    const answers: Answers = new Map([
      [`https://api.github.com/repos/floor/material/releases/tags/v${version}`, json({ draft: false, prerelease: true })],
    ]);
    const { result } = await run(answers, MATERIAL, version);
    expect(result.github.status).toBe('pass');
  });

  test('a 404 is missing', async () => {
    const { result } = await run(withAnswer(happy(), URLS.release, json({}, 404)));
    expect(result.github).toEqual({ status: 'missing', detail: 'GitHub has no release for v3.0.2' });
  });

  test('a draft is missing', async () => {
    const { result } = await run(withChange(happy(), URLS.release, (value) => ({ ...value, draft: true })));
    expect(result.github).toEqual({ status: 'missing', detail: 'the release is a draft' });
  });

  test('the prerelease flag must match the version, both ways', async () => {
    const marked = await run(withChange(happy(), URLS.release, (value) => ({ ...value, prerelease: true })));
    expect(marked.result.github).toEqual({ status: 'missing', detail: 'the release is marked as a prerelease' });

    const version = '1.0.0-alpha';
    const answers: Answers = new Map([
      [`https://api.github.com/repos/floor/material/releases/tags/v${version}`, json({ draft: false, prerelease: false })],
    ]);
    const unmarked = await run(answers, MATERIAL, version);
    expect(unmarked.result.github).toEqual({ status: 'missing', detail: 'the release is not marked as a prerelease' });
  });

  test('a non-boolean draft or prerelease is unknown', async () => {
    for (const change of [{ draft: 'no' }, { prerelease: 1 }]) {
      const { result } = await run(withChange(happy(), URLS.release, (value) => ({ ...value, ...change })));
      expect(result.github.status).toBe('unknown');
    }
  });
});

describe('the changelog check', () => {
  test('pass: the bracketed heading, with the fixed detail', async () => {
    const { result } = await run(happy());
    expect(result.changelog).toEqual({ status: 'pass', detail: 'changelog entry has a valid release date' });
  });

  test('pass: the plain heading', async () => {
    const { result } = await run(withChange(happy(), URLS.changelog, () => changelog('## 3.0.2 - 2026-10-01\n')));
    expect(result.changelog.status).toBe('pass');
  });

  test('leap years: 2024 and 2000 pass, 2100 does not', async () => {
    for (const [date, status] of [['2024-02-29', 'pass'], ['2000-02-29', 'pass'], ['2100-02-29', 'missing']] as const) {
      const { result } = await run(withChange(happy(), URLS.changelog, () => changelog(`## [3.0.2] - ${date}\n`)));
      expect(result.changelog.status).toBe(status);
    }
  });

  test('an invalid calendar date is missing: 2026-02-30, 1969-12-31, 2100-02-29', async () => {
    for (const date of ['2026-02-30', '1969-12-31', '2100-02-29']) {
      const { result } = await run(withChange(happy(), URLS.changelog, () => changelog(`## [3.0.2] - ${date}\n`)));
      expect(result.changelog).toEqual({ status: 'missing', detail: 'the changelog entry for 3.0.2 has an invalid date' });
    }
  });

  test('no entry for the version is missing', async () => {
    const { result } = await run(withChange(happy(), URLS.changelog, () => changelog('# Changelog\n\n## [3.0.1] - 2026-09-28\n')));
    expect(result.changelog).toEqual({ status: 'missing', detail: 'CHANGELOG.md has no entry for 3.0.2' });
  });

  test('near misses do not count: another level, a v-prefix, a longer version, one bracket', async () => {
    for (const heading of ['### [3.0.2] - 2026-10-01', '## [v3.0.2] - 2026-10-01', '## [3.0.20] - 2026-10-01', '## [3.0.2 - 2026-10-01', '## 3.0.2] - 2026-10-01', '## 3.0.2 2026-10-01']) {
      const { result } = await run(withChange(happy(), URLS.changelog, () => changelog(`${heading}\n`)));
      expect(result.changelog.status).toBe('missing');
    }
  });

  test('a 404 is missing', async () => {
    const { result } = await run(withAnswer(happy(), URLS.changelog, json({}, 404)));
    expect(result.changelog).toEqual({ status: 'missing', detail: 'the default branch has no CHANGELOG.md' });
  });

  test('a non-file, a non-base64 encoding, bad base64 and bad UTF-8 are unknown', async () => {
    const dir = await run(withChange(happy(), URLS.changelog, (value) => ({ ...value, type: 'dir' })));
    expect(dir.result.changelog.status).toBe('unknown');

    const encoding = await run(withChange(happy(), URLS.changelog, (value) => ({ ...value, encoding: 'none' })));
    expect(encoding.result.changelog.status).toBe('unknown');

    const base64 = await run(withChange(happy(), URLS.changelog, (value) => ({ ...value, content: '!!!' })));
    expect(base64.result.changelog.status).toBe('unknown');

    const utf8 = await run(withChange(happy(), URLS.changelog, (value) => ({
      ...value,
      content: `${Buffer.from([0xff, 0xfe, 0x41]).toString('base64')}\n`,
    })));
    expect(utf8.result.changelog.status).toBe('unknown');
  });
});

describe('the stale next warning', () => {
  const STALE = "npm's next dist-tag points at 3.0.1, older than latest 3.0.2: run npm dist-tag add material@3.0.2 next";
  const tags = (latest: unknown, next: unknown): Answers => withAnswer(happy(), URLS.tags, json({ latest, next }));
  const everyCheckPasses = (result: ReleaseResult): void => {
    for (const check of Object.values(result)) if (typeof check !== 'string') expect(check.status).toBe('pass');
  };

  test('a next tag behind latest warns once, naming the exact npm command, and no check changes', async () => {
    const { result, requested } = await run(tags('3.0.2', '3.0.1'));
    expect(result.warning).toBe(STALE);
    expect(requested).toContain(URLS.tags);
    everyCheckPasses(result);
  });

  test('a next tag level with or ahead of latest is silent', async () => {
    const cases: [string, string][] = [['3.0.2', '3.0.2'], ['3.0.2', '3.0.3'], ['3.0.2', '4.0.0'], ['4.0.0', '5.0.0-rc.1']];
    for (const [latest, next] of cases) expect((await run(tags(latest, next))).result.warning).toBeUndefined();
  });

  test('the prerelease order decides: 3.0.0-rc.1 is behind 3.0.0', async () => {
    const behind = await run(tags('3.0.0', '3.0.0-rc.1'));
    expect(behind.result.warning).toBe(
      "npm's next dist-tag points at 3.0.0-rc.1, older than latest 3.0.0: run npm dist-tag add material@3.0.0 next",
    );
    expect((await run(tags('3.0.0-rc.1', '3.0.0'))).result.warning).toBeUndefined();
  });

  test('tags that cannot be compared are no warning: absent, non-string, or not a version', async () => {
    const cases: [unknown, unknown][] = [
      [undefined, '3.0.1'], ['3.0.2', undefined], ['3.0.2', null], [3.02, '3.0.1'], ['3.0.2', 301],
      ['3.0.2', 'latest'], ['3.0.2', 'v3.0.1'], ['not-a-version', '3.0.1'],
    ];
    for (const [latest, next] of cases) expect((await run(tags(latest, next))).result.warning).toBeUndefined();
  });

  test('a dist-tags read that fails is silent: a 404, and a 500 twice', async () => {
    const stale = { latest: '3.0.2', next: '3.0.1' };
    const absent = await run(withAnswer(happy(), URLS.tags, json(stale, 404)));
    expect(absent.result.warning).toBeUndefined();
    const twice = await run(withAnswer(happy(), URLS.tags, [json(stale, 500), json(stale, 500)]));
    expect(twice.result.warning).toBeUndefined();
    // The failed read is still a read: it is retried once, like every other endpoint.
    expect(twice.requested.filter((url) => url === URLS.tags).length).toBe(2);
  });

  test('a body that is not the JSON document is silent too', async () => {
    const garbage = await run(withAnswer(happy(), URLS.tags, { kind: 'http', status: 200, body: 'not json' }));
    expect(garbage.result.warning).toBeUndefined();
  });
});

describe('the network contract', () => {
  test('a 500 is retried exactly once: 500 then 200 passes, 500 twice is unknown', async () => {
    const answers = happy();
    answers.set(URLS.npm, [json({}, 500), json(fixture('npm-version.json'))]);
    const retried = await run(answers);
    expect(retried.result.npm.status).toBe('pass');
    expect(retried.requested.filter((url) => url === URLS.npm).length).toBe(2);

    const twice = happy();
    twice.set(URLS.npm, [json({}, 500), json({}, 500)]);
    const failed = await run(twice);
    expect(failed.result.npm.status).toBe('unknown');
    expect(failed.requested.filter((url) => url === URLS.npm).length).toBe(2);
  });

  test('429 and 408 are retried once; a timeout and a transport failure are retried once', async () => {
    for (const failure of [json({}, 429), json({}, 408), { kind: 'timeout' } as const, { kind: 'transport' } as const]) {
      const answers = happy();
      answers.set(URLS.npm, [failure, json(fixture('npm-version.json'))]);
      const { result } = await run(answers);
      expect(result.npm.status).toBe('pass');
    }
    const twice = happy();
    twice.set(URLS.npm, [{ kind: 'timeout' }, { kind: 'timeout' }]);
    const { result } = await run(twice);
    expect(result.npm.status).toBe('unknown');
  });

  test('a 400, a redirect and a body over the limit are not retried', async () => {
    for (const failure of [json({}, 400), json({}, 302), { kind: 'too-large', status: 200, prefix: '' } as const]) {
      const answers = happy();
      answers.set(URLS.npm, [failure, json(fixture('npm-version.json'))]);
      const { result, requested } = await run(answers);
      expect(result.npm.status).toBe('unknown');
      expect(requested.filter((url) => url === URLS.npm).length).toBe(1);
    }
  });

  test('a retryable status with an oversized body is still retried: exactly two attempts, then unknown', async () => {
    for (const status of [408, 429, 503]) {
      const answers = happy();
      answers.set(URLS.npm, [{ kind: 'too-large', status, prefix: '' }, json(fixture('npm-version.json'))]);
      const { result, requested } = await run(answers);
      expect(result.npm.status).toBe('pass');
      expect(requested.filter((url) => url === URLS.npm).length).toBe(2);
    }
    const twice = happy();
    twice.set(URLS.npm, [{ kind: 'too-large', status: 503, prefix: '' }, { kind: 'too-large', status: 503, prefix: '' }]);
    const { result, requested } = await run(twice);
    expect(result.npm.status).toBe('unknown');
    expect(requested.filter((url) => url === URLS.npm).length).toBe(2);
  });

  test('an undecodable body is unknown and, with a non-retryable status, not retried', async () => {
    const answers = happy();
    answers.set(URLS.npm, [{ kind: 'undecodable', status: 200 }, json(fixture('npm-version.json'))]);
    const { result, requested } = await run(answers);
    expect(result.npm.status).toBe('unknown');
    expect(requested.filter((url) => url === URLS.npm).length).toBe(1);
  });

  test('a retryable status whose body cannot be decoded is still retried: two attempts, then the answer', async () => {
    for (const status of [408, 429, 503]) {
      const answers = happy();
      answers.set(URLS.npm, [{ kind: 'undecodable', status }, json(fixture('npm-version.json'))]);
      const { result, requested } = await run(answers);
      expect(result.npm.status).toBe('pass');
      expect(requested.filter((url) => url === URLS.npm).length).toBe(2);
    }
    const twice = happy();
    twice.set(URLS.npm, [{ kind: 'undecodable', status: 503 }, { kind: 'undecodable', status: 503 }]);
    const { result, requested } = await run(twice);
    expect(result.npm.status).toBe('unknown');
    expect(requested.filter((url) => url === URLS.npm).length).toBe(2);
  });

  test('the docs page names exactly the retry set the code retries', () => {
    // The page can't drift from the code again: the statuses its retry sentence names are the
    // statuses `retried()` retries, status by status, and the no-response kinds match too.
    const page = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'commands', 'release.md'), 'utf8');
    const paragraph = page.split('\n\n').find((text) => text.includes('retried exactly once'));
    expect(paragraph).toBeDefined();
    const sentence = (paragraph as string).split(/(?<=\.)\s+/).find((text) => text.includes('retried exactly once')) as string;
    const named = new Set<number>();
    for (const token of sentence.matchAll(/([1-5])([0-9]{2}|xx)/g)) {
      if (token[2] === 'xx') for (let status = Number(token[1]) * 100; status < Number(token[1]) * 100 + 100; status++) named.add(status);
      else named.add(Number(token[0]));
    }
    expect(named.size).toBeGreaterThan(0);
    for (let status = 100; status <= 599; status++) {
      expect(retried({ kind: 'http', status, body: '' })).toBe(named.has(status));
    }
    expect(sentence).toContain('timeout');
    expect(sentence).toContain('transport');
    expect(retried({ kind: 'timeout' })).toBe(true);
    expect(retried({ kind: 'transport' })).toBe(true);
    expect(retried({ kind: 'undecodable', status: 200 })).toBe(false);
  });

  test('the maximal run stays inside the caps: twelve reads, twenty-four attempts', async () => {
    // Trusted publishing and a chain of four tag objects: every endpoint read there is, each
    // answered 500 then 200, so every read costs both its attempts.
    const shas = ['b', 'c', 'd', 'e'].map((letter) => letter.repeat(40));
    const chain = [TAG_OBJECT, ...shas];
    const urls = [
      URLS.npm, URLS.attest, URLS.tags, URLS.repo, URLS.ref,
      ...chain.slice(0, 4).map((sha) => `https://api.github.com/repos/floor/material/git/tags/${sha}`),
      `https://api.github.com/repos/floor/material/compare/${shas[3]}...main`,
      URLS.release, URLS.changelog,
    ];
    const ok = new Map<string, Record<string, unknown>>([
      [URLS.npm, fixture('npm-version.json')],
      [URLS.attest, fixture('npm-attestations.json')],
      [URLS.tags, { latest: '3.0.2', next: '3.0.2' }],
      [URLS.repo, fixture('github-repo.json')],
      [URLS.ref, fixture('github-tag-ref-annotated.json')],
      [URLS.release, fixture('github-release.json')],
      [URLS.changelog, fixture('github-contents.json')],
      [`https://api.github.com/repos/floor/material/compare/${shas[3]}...main`, fixture('github-compare.json')],
    ]);
    for (let index = 0; index < 4; index++) {
      const at = chain[index] as string;
      ok.set(`https://api.github.com/repos/floor/material/git/tags/${at}`, tagObject(at, chain[index + 1] as string, index === 3 ? 'commit' : 'tag'));
    }
    const answers: Answers = new Map(urls.map((url) => [url, [json({}, 500), json(ok.get(url) as Record<string, unknown>)]]));
    const { result, requested } = await run(answers);
    expect(new Set(requested)).toEqual(new Set(urls));
    expect(urls.length).toBe(12);
    expect(requested.length).toBe(24);
    expect(result.warning).toBeUndefined();
    for (const check of Object.values(result)) if (typeof check !== 'string') expect(check.status).toBe('pass');
  });

  test('a read that would exceed the read cap is not made, and its checks are unknown', async () => {
    const { result, requested } = await run(happy(), MATERIAL, '3.0.2', { reads: 2, attempts: 22 });
    expect(requested).toEqual([URLS.npm, URLS.attest]);
    expect(result.npm.status).toBe('pass');
    expect(result.tag.status).toBe('unknown');
    expect(result.github.status).toBe('unknown');
    expect(result.changelog.status).toBe('unknown');
  });

  test('an attempt that would exceed the attempt cap is not made', async () => {
    const { result, requested } = await run(happy(), MATERIAL, '3.0.2', { reads: 11, attempts: 1 });
    expect(requested).toEqual([URLS.npm]);
    expect(result.npm.status).toBe('unknown');
    expect(result.tag.status).toBe('unknown');
  });
});

describe('the encoding', () => {
  test('a scoped package is one segment, and the attestation path encodes package@version as one', async () => {
    const decl: ReleaseDecl = { package: '@scope/name', github: 'floor/material', trustedPublishing: true };
    const { requested } = await run(new Map(), decl, '1.2.3');
    // Every read fails and is retried here; the assertion is on the URLs themselves.
    expect(requested).toContain('https://registry.npmjs.org/%40scope%2Fname/1.2.3');
    expect(requested).toContain('https://registry.npmjs.org/-/npm/v1/attestations/%40scope%2Fname%401.2.3');
    expect(requested).toContain('https://registry.npmjs.org/-/package/%40scope%2Fname/dist-tags');
    for (const url of requested) expect(url).not.toContain('@scope');
  });

  test('a default branch with a slash is one query value and one compare segment', async () => {
    const answers = withChange(happy(), URLS.repo, (value) => ({ ...value, default_branch: 'release/3' }));
    answers.delete(URLS.compare);
    answers.set(`https://api.github.com/repos/floor/material/compare/${COMMIT}...release%2F3`, json(fixture('github-compare.json')));
    answers.delete(URLS.changelog);
    answers.set('https://api.github.com/repos/floor/material/contents/CHANGELOG.md?ref=release%2F3', json(fixture('github-contents.json')));
    const { result, requested } = await run(answers);
    expect(requested).toContain(`https://api.github.com/repos/floor/material/compare/${COMMIT}...release%2F3`);
    expect(requested).toContain('https://api.github.com/repos/floor/material/contents/CHANGELOG.md?ref=release%2F3');
    expect(result.tag.status).toBe('pass');
    expect(result.changelog.status).toBe('pass');
  });

  test('encodeSegment leaves the unreserved set and escapes the rest, uppercase', () => {
    expect(encodeSegment('main')).toBe('main');
    expect(encodeSegment('a/b c')).toBe('a%2Fb%20c');
    expect(encodeSegment('~x-y_z.9')).toBe('~x-y_z.9');
    expect(encodeSegment('é')).toBe('%C3%A9');
  });
});

describe('the compound rule', () => {
  test('no short-circuit after a missing condition: independent reads are still made', async () => {
    const { result, requested } = await run(withAnswer(happy(), URLS.npm, json({}, 404)));
    expect(result.npm.status).toBe('missing');
    expect(requested).toEqual([URLS.npm, URLS.attest, URLS.tags, URLS.repo, URLS.ref, URLS.compare, URLS.release, URLS.changelog]);
    expect(result.tag.status).toBe('pass');
    expect(result.github.status).toBe('pass');
    expect(result.changelog.status).toBe('pass');
  });

  test('an upstream unknown makes the check unknown, and its downstream is not requested', async () => {
    const answers = happy();
    answers.set(URLS.ref, [json({}, 500), json({}, 500)]);
    const { result, requested } = await run(answers);
    expect(result.tag.status).toBe('unknown');
    expect(requested).not.toContain(URLS.compare);
    expect(requested).toEqual([URLS.npm, URLS.attest, URLS.tags, URLS.repo, URLS.ref, URLS.ref, URLS.release, URLS.changelog]);
  });
});
