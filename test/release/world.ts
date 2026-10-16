// The recorded npm and GitHub answers the release tests replay, and a fetch that serves them.
// No test here makes a real network request: the fetch is this map, and an unlisted URL is a
// transport failure the test can see in `requested`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, Fetch, RequestOptions } from '../../src/release/http.ts';
import type { ReleaseDecl } from '../../src/file/sections/releases.ts';

export const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'release');

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

export function json(value: unknown, status = 200): Attempt {
  return { kind: 'http', status, body: JSON.stringify(value) };
}

export type Answers = Map<string, Attempt | Attempt[]>;

/** One recorded request: the URL and, for the Linear POST, the options it carried. */
export type Recorded = { url: string; request?: RequestOptions };

export function fakeFetch(answers: Answers): { fetcher: Fetch; requested: string[]; requests: Recorded[] } {
  const requested: string[] = [];
  const requests: Recorded[] = [];
  const used = new Map<string, number>();
  const fetcher: Fetch = (url, request) => {
    requested.push(url);
    requests.push(request === undefined ? { url } : { url, request });
    const answer = answers.get(url);
    if (answer === undefined) return Promise.resolve({ kind: 'transport' });
    if (Array.isArray(answer)) {
      const at = used.get(url) ?? 0;
      used.set(url, at + 1);
      return Promise.resolve(answer[Math.min(at, answer.length - 1)] as Attempt);
    }
    return Promise.resolve(answer);
  };
  return { fetcher, requested, requests };
}

export const COMMIT = '1111111111111111111111111111111111111111';
export const TAG_OBJECT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export const MATERIAL: ReleaseDecl = { package: 'material', github: 'floor/material', trustedPublishing: true };

/* The release-records configuration: the Linear project, its Keychain service, the activity
 * file and marker. The key under test is a deliberate non-real string. */
export const PROJECT_ID = '01234567-89ab-cdef-0123-456789abcdef';
export const SERVICE = 'team.linear.material';
export const KEY = 'test-key-not-real';

export const MATERIAL_RECORDS: ReleaseDecl = {
  ...MATERIAL,
  linear: { project: PROJECT_ID, keychainService: SERVICE },
  activity: { file: 'activity/2026/material.md', marker: 'release: <package>@<version>' },
};

export const MARKER_LINE = 'release: material@3.0.2';

export const URLS = {
  npm: 'https://registry.npmjs.org/material/3.0.2',
  attest: 'https://registry.npmjs.org/-/npm/v1/attestations/material%403.0.2',
  tags: 'https://registry.npmjs.org/-/package/material/dist-tags',
  repo: 'https://api.github.com/repos/floor/material',
  ref: 'https://api.github.com/repos/floor/material/git/ref/tags/v3.0.2',
  tagObject: `https://api.github.com/repos/floor/material/git/tags/${TAG_OBJECT}`,
  compare: `https://api.github.com/repos/floor/material/compare/${COMMIT}...main`,
  release: 'https://api.github.com/repos/floor/material/releases/tags/v3.0.2',
  changelog: 'https://api.github.com/repos/floor/material/contents/CHANGELOG.md?ref=main',
  activity: 'https://api.github.com/repos/floor/material/contents/activity/2026/material.md?ref=main',
  linear: 'https://api.linear.app/graphql',
};

/** Every read of one passing run for material@3.0.2, trusted publishing declared. The dist-tags
 *  document is well formed with `next` level with `latest`: the warning's own tests change it. */
export function happy(trusted = true): Answers {
  const answers: Answers = new Map([
    [URLS.npm, json(fixture('npm-version.json'))],
    [URLS.tags, json({ latest: '3.0.2', next: '3.0.2' })],
    [URLS.repo, json(fixture('github-repo.json'))],
    [URLS.ref, json(fixture('github-tag-ref-lightweight.json'))],
    [URLS.compare, json(fixture('github-compare.json'))],
    [URLS.release, json(fixture('github-release.json'))],
    [URLS.changelog, json(fixture('github-contents.json'))],
  ]);
  if (trusted) answers.set(URLS.attest, json(fixture('npm-attestations.json')));
  return answers;
}

/** A well-formed Linear answer: the active project, one `done` milestone named 3.0.2, one
 *  qualifying update at noon of the release day — every field overridable per case, including
 *  to a malformed value (the key's presence, not its truthiness, decides). */
export function linearAnswer(change: {
  project?: Record<string, unknown>;
  milestones?: unknown[];
  updates?: unknown[];
  milestonesPageInfo?: unknown;
  updatesPageInfo?: unknown;
} = {}): Record<string, unknown> {
  const pick = (key: 'milestones' | 'updates' | 'milestonesPageInfo' | 'updatesPageInfo', fallback: unknown): unknown =>
    key in change ? change[key] : fallback;
  return {
    data: {
      project: {
        id: PROJECT_ID,
        archivedAt: null,
        projectMilestones: {
          nodes: pick('milestones', [{ name: '3.0.2', status: 'done' }]),
          pageInfo: pick('milestonesPageInfo', { hasNextPage: false }),
        },
        projectUpdates: {
          nodes: pick('updates', [{ createdAt: '2026-10-01T12:00:00Z', archivedAt: null }]),
          pageInfo: pick('updatesPageInfo', { hasNextPage: false }),
        },
        ...(change.project ?? {}),
      },
    },
  };
}

/** A contents response holding `text` for the activity file. */
export function activityFile(text: string): Record<string, unknown> {
  return {
    name: 'material.md',
    path: 'activity/2026/material.md',
    type: 'file',
    encoding: 'base64',
    content: `${Buffer.from(text, 'utf8').toString('base64')}\n`,
  };
}

/** Every read of one passing records run: the public records, the marker, the Linear answer. */
export function happyRecords(): Answers {
  const answers = happy();
  answers.set(URLS.activity, json(activityFile(`# Activity\n\nSome earlier line.\n${MARKER_LINE}\n`)));
  answers.set(URLS.linear, json(linearAnswer()));
  return answers;
}

/** A tag object in an annotated chain: `from` reads as a tag object pointing at `to`. */
export function tagObject(sha: string, toSha: string, toType: string): Record<string, unknown> {
  return { sha, tag: 'v3.0.2', object: { sha: toSha, type: toType } };
}

/** A CHANGELOG.md contents response holding `text`. */
export function changelog(text: string): Record<string, unknown> {
  return {
    name: 'CHANGELOG.md',
    path: 'CHANGELOG.md',
    type: 'file',
    encoding: 'base64',
    content: `${Buffer.from(text, 'utf8').toString('base64')}\n`,
  };
}

export function withChange(answers: Answers, url: string, change: (value: Record<string, unknown>) => unknown): Answers {
  const answer = answers.get(url);
  if (answer === undefined || Array.isArray(answer) || answer.kind !== 'http') throw new Error(`no JSON answer for ${url}`);
  answers.set(url, json(change(JSON.parse(answer.body) as Record<string, unknown>)));
  return answers;
}

/** Replace one endpoint's answer outright — a status, a failure kind, or an attempt sequence. */
export function withAnswer(answers: Answers, url: string, answer: Attempt | Attempt[]): Answers {
  answers.set(url, answer);
  return answers;
}
