// The repository read a public-only session leg makes before it hands a hosted CLI `owner/repo`:
// one credential-free GET of the forge's own record, and only a 200 whose record says
// `private: false` is public. Every answer the wire can give is read here with a stand-in fetch;
// no scene makes a network call.
import { describe, expect, test } from 'bun:test';
import type { Attempt, Fetch, RequestOptions } from '../src/release/http.ts';
import { repoReadWith } from '../src/send/repo-visibility.ts';

function recording(answer: Attempt): { fetch: Fetch; calls: { url: string; request?: RequestOptions }[] } {
  const calls: { url: string; request?: RequestOptions }[] = [];
  const fetch: Fetch = async (url, request) => {
    calls.push(request === undefined ? { url } : { url, request });
    return answer;
  };
  return { fetch, calls };
}

const read = (answer: Attempt) => repoReadWith(recording(answer).fetch);

describe('the repository record the public-only session leg reads', () => {
  test('a 200 record marked private: false is public; marked true is not', async () => {
    expect(await read({ kind: 'http', status: 200, body: '{"private":false,"name":"site"}' })('acme/site')).toBe('public');
    expect(await read({ kind: 'http', status: 200, body: '{"private":true,"name":"site"}' })('acme/site')).toBe('not-public');
  });

  test('a 404 is the forge not showing the repository: not public', async () => {
    expect(await read({ kind: 'http', status: 404, body: '{"message":"Not Found"}' })('acme/site')).toBe('not-public');
  });

  test('a read that cannot be made or read is unread, never public', async () => {
    expect(await read({ kind: 'timeout' })('acme/site')).toBe('unread');
    expect(await read({ kind: 'transport' })('acme/site')).toBe('unread');
    expect(await read({ kind: 'http', status: 403, body: '{"message":"rate limit"}' })('acme/site')).toBe('unread');
    expect(await read({ kind: 'http', status: 200, body: 'not the record' })('acme/site')).toBe('unread');
    expect(await read({ kind: 'http', status: 200, body: '{"private":"false"}' })('acme/site')).toBe('unread');
    expect(await read({ kind: 'too-large', status: 200, prefix: '{"private":false' })('acme/site')).toBe('unread');
    expect(await read({ kind: 'undecodable', status: 200 })('acme/site')).toBe('unread');
  });

  test('one GET of the repository path and nothing else: no header, no request of its own', async () => {
    const wire = recording({ kind: 'http', status: 200, body: '{"private":false}' });
    expect(await repoReadWith(wire.fetch)('acme/site')).toBe('public');
    expect(wire.calls).toEqual([{ url: 'https://api.github.com/repos/acme/site' }]);
  });
});
