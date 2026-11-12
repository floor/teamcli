// The checks team git and team gh make before anything runs.
import { describe, expect, test } from 'bun:test';
import { ghRefusal, gitRefusal } from '../src/commands/git.ts';

test('a push of the seat\'s own branch passes; force, delete, mirror and trunk pushes are refused', () => {
  expect(gitRefusal('push', ['origin', 'feat/x'], 'feat/x')).toBeNull();
  expect(gitRefusal('push', ['-u', 'origin', 'feat/x'], 'feat/x')).toBeNull();
  for (const args of [['--force'], ['-f', 'origin', 'x'], ['--force-with-lease'], ['origin', '+x'], ['--delete', 'origin', 'x'], ['--mirror'], ['--all']]) {
    expect(gitRefusal('push', args, 'x'), args.join(' ')).not.toBeNull();
  }
  expect(gitRefusal('push', ['origin', 'main'], 'feat/x')).toContain('main');
  expect(gitRefusal('push', ['origin', 'HEAD:refs/heads/master'], 'feat/x')).toContain('master');
  expect(gitRefusal('push', [], 'main')).toContain('main');
});

test('fetch and pull pass; any other git verb goes to plain git', () => {
  expect(gitRefusal('fetch', ['origin'], 'main')).toBeNull();
  expect(gitRefusal('pull', [], 'main')).toBeNull();
  expect(gitRefusal('commit', ['-m', 'x'], 'x')).not.toBeNull();
});

test('gh reads and ordinary writes pass; merge, release, credentials and api writes are refused', () => {
  expect(ghRefusal(['pr', 'view', '12'])).toBeNull();
  expect(ghRefusal(['issue', 'comment', '3', '--body', 'x'])).toBeNull();
  expect(ghRefusal(['api', 'repos/o/r/pulls'])).toBeNull();
  expect(ghRefusal(['pr', 'merge', '12'])).not.toBeNull();
  expect(ghRefusal(['release', 'create', 'v1'])).not.toBeNull();
  expect(ghRefusal(['auth', 'token'])).not.toBeNull();
  expect(ghRefusal(['secret', 'set', 'X'])).not.toBeNull();
  expect(ghRefusal(['repo', 'delete', 'o/r'])).not.toBeNull();
  expect(ghRefusal(['api', '-X', 'POST', 'repos/o/r/issues'])).not.toBeNull();
  expect(ghRefusal(['api', 'repos/o/r/issues', '-f', 'title=x'])).not.toBeNull();
  expect(ghRefusal([])).not.toBeNull();
});

describe('gh api refusals read every spelling gh takes (review finding 1)', () => {
  test('attached and = forms of a method or a field are refused', () => {
    for (const args of [
      ['api', 'repos/o/r/issues', '--method=POST'],
      ['api', 'repos/o/r/issues', '-XPOST'],
      ['api', 'repos/o/r/issues', '-X', 'PATCH'],
      ['api', 'repos/o/r/issues', '--field=title=x'],
      ['api', 'repos/o/r/issues', '--raw-field=body=x'],
      ['api', 'repos/o/r/issues', '--input=body.json'],
      ['api', 'repos/o/r/issues', '-ftitle=x'],
      ['api', 'repos/o/r/issues', '-Fbody=@x'],
      ['api', 'graphql', '-q', '.data'],
    ]) expect(ghRefusal(args), args.join(' ')).not.toBeNull();
  });

  test('a plain read is still allowed', () => {
    expect(ghRefusal(['api', 'repos/o/r/pulls'])).toBeNull();
    expect(ghRefusal(['api', 'repos/o/r/pulls', '--method', 'GET'])).toBeNull();
    expect(ghRefusal(['api', 'repos/o/r/pulls', '--jq', '.[].number'])).toBeNull();
  });
});
