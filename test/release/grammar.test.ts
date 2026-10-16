// The grammars of the `releases:` section and the command's argument: Semantic Versioning 2.0.0,
// the npm package name, and the GitHub owner/repo, accepted and refused cases.
import { describe, expect, test } from 'bun:test';
import {
  GITHUB_PATTERN, LINEAR_PROJECT_PATTERN, PACKAGE_PATTERN, SEMVER_PATTERN, activityFileProblem, activityMarkerProblem,
  compareVersions, hasPrerelease, keychainServiceProblem, packageProblem,
} from '../../src/release/grammar.ts';

describe('the SemVer 2.0.0 grammar', () => {
  const accepted = [
    '0.0.0', '1.2.3', '10.20.30', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x-y-z.-',
    '1.0.0-0a', '1.0.0-alpha-1', '1.0.0+build.1', '1.0.0+20130313144700', '1.0.0-alpha+001',
    '1.0.0-rc.1+build-5', '9999.9999.9999',
  ];
  const refused = [
    'v1.2.3', 'V1.2.3', '1.2', '1.2.3.4', '1', '01.2.3', '1.02.3', '1.2.03', '1.0.0-01',
    '1.0.0-', '1.0.0+', '1.0.0-alpha..1', '1.0.0-alpha.01', '1.2.3 ', ' 1.2.3', '1.2.3+é',
    '', '3.0.2\n', '1.2.3-alpha_beta',
  ];
  for (const version of accepted) test(`accepts ${version}`, () => expect(SEMVER_PATTERN.test(version)).toBe(true));
  for (const version of refused) test(`refuses ${JSON.stringify(version)}`, () => expect(SEMVER_PATTERN.test(version)).toBe(false));

  test('the prerelease part, never the build part, decides the channel', () => {
    expect(hasPrerelease('1.0.0-alpha')).toBe(true);
    expect(hasPrerelease('1.0.0-alpha.1+x-y')).toBe(true);
    expect(hasPrerelease('1.0.0')).toBe(false);
    expect(hasPrerelease('1.0.0+build-x')).toBe(false);
  });
});

describe('the version precedence (SemVer 2.0.0 §11)', () => {
  const cases: [string, string, number][] = [
    ['1.2.3', '1.2.3', 0], ['1.2.3', '1.2.4', -1], ['1.2.3', '1.3.0', -1], ['1.2.3', '2.0.0', -1],
    ['2.0.0', '1.9.9', 1], ['3.0.1', '3.0.2', -1], ['10.0.0', '9.0.0', 1],
    // A prerelease is always lower than the release it precedes.
    ['1.0.0-alpha', '1.0.0', -1], ['1.0.0', '1.0.0-rc.1', 1], ['1.0.0-rc.1', '1.0.0-rc.2', -1],
    // Its fields decide in order: numeric before alphanumeric, numbers by value, more fields first.
    ['1.0.0-1', '1.0.0-alpha', -1], ['1.0.0-2', '1.0.0-10', -1], ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1], ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    // Build metadata never decides.
    ['1.0.0+build.1', '1.0.0+build.2', 0], ['1.0.0-alpha+001', '1.0.0-alpha', 0],
    ['1.0.0-alpha+1', '1.0.0', -1],
  ];
  for (const [one, two, order] of cases) {
    test(`${one} ${order === 0 ? 'equals' : order < 0 ? 'is below' : 'is above'} ${two}`, () => expect(compareVersions(one, two)).toBe(order));
  }

  test('a string that is not a version decides nothing', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBeNull();
    expect(compareVersions('1.2.3', 'latest')).toBeNull();
    expect(compareVersions('', '1.2.3')).toBeNull();
    expect(compareVersions('1.0.0', '3.0.2\n')).toBeNull();
  });
});

describe('the package grammar', () => {
  const accepted = ['material', '@scope/name', 'a', '@a/b', 'my-pkg.name_2', '@scope-2/name.x.y', 'vlist'];
  const refused = [
    'Material', '-material', '.material', '_material', 'material/name', '@scope', '@scope/',
    '@scope//name', '@Scope/name', '@scope/Name', '@scope/name/extra', 'material name', 'matérial',
    '', '@/name', '@scope/name ',
  ];
  for (const name of accepted) test(`accepts ${name}`, () => expect(packageProblem(name)).toBeNull());
  for (const name of refused) test(`refuses ${JSON.stringify(name)}`, () => expect(packageProblem(name)).not.toBeNull());

  test('refuses a name over 214 bytes', () => {
    expect(packageProblem(`@s/${'a'.repeat(211)}`)).toBeNull(); // 214 bytes exactly
    expect(packageProblem('a'.repeat(215))).not.toBeNull();
    expect(packageProblem('a'.repeat(214))).toBeNull();
  });
});

describe('the github grammar', () => {
  const accepted = ['floor/material', 'a/b', 'Floor-IO/material.addons_1', `${'x'.repeat(100)}/y`];
  const refused = [
    'floor', 'floor/material/extra', '/material', 'floor/', 'floor//material', 'floor /material',
    'floor/material ', '.floor/material', '-floor/material', 'floor/.material', 'floor/mate riàl',
    `${'x'.repeat(101)}/y`, '', 'floor/mat:rial',
  ];
  for (const repo of accepted) test(`accepts ${repo.length > 30 ? 'a 100-character owner' : repo}`, () => expect(GITHUB_PATTERN.test(repo)).toBe(true));
  for (const repo of refused) test(`refuses ${JSON.stringify(repo.length > 30 ? 'a 101-character owner' : repo)}`, () => expect(GITHUB_PATTERN.test(repo)).toBe(false));
});

describe('the Linear project grammar', () => {
  const accepted = ['01234567-89ab-cdef-0123-456789abcdef', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '00000000-0000-0000-0000-000000000000'];
  const refused = [
    '01234567-89AB-cdef-0123-456789abcdef', '01234567-89ab-cdef-0123-456789abcde', '01234567-89ab-cdef-0123-456789abcdef0',
    '0123456789ab-cdef-0123-456789abcdef', 'g1234567-89ab-cdef-0123-456789abcdef', '01234567_89ab_cdef_0123_456789abcdef',
    'not-a-uuid', '', ' 01234567-89ab-cdef-0123-456789abcdef',
  ];
  for (const id of accepted) test(`accepts ${id}`, () => expect(LINEAR_PROJECT_PATTERN.test(id)).toBe(true));
  for (const id of refused) test(`refuses ${JSON.stringify(id)}`, () => expect(LINEAR_PROJECT_PATTERN.test(id)).toBe(false));
});

describe('the Keychain service grammar', () => {
  test('accepts a service name, spaces and punctuation included, to 255 bytes', () => {
    expect(keychainServiceProblem('team.linear.material')).toBeNull();
    expect(keychainServiceProblem('team linear (material)')).toBeNull();
    expect(keychainServiceProblem('s'.repeat(255))).toBeNull();
    expect(keychainServiceProblem('é'.repeat(127))).toBeNull(); // 254 bytes
  });

  test('refuses an empty name, one over 255 bytes, or a control character', () => {
    expect(keychainServiceProblem('')).not.toBeNull();
    expect(keychainServiceProblem('s'.repeat(256))).not.toBeNull();
    expect(keychainServiceProblem('é'.repeat(128))).not.toBeNull(); // 256 bytes
    expect(keychainServiceProblem('a\tb')).not.toBeNull();
    expect(keychainServiceProblem('a\nb')).not.toBeNull();
    expect(keychainServiceProblem('a\x7fb')).not.toBeNull();
    expect(keychainServiceProblem('a\u0085b')).not.toBeNull();
  });
});

describe('the activity file grammar', () => {
  test('accepts repository-relative paths of name segments', () => {
    expect(activityFileProblem('activity/2026/material.md')).toBeNull();
    expect(activityFileProblem('CHANGELOG.md')).toBeNull();
    expect(activityFileProblem('a/b_c.d-e/f')).toBeNull();
    expect(activityFileProblem(`a/${'s'.repeat(128)}`)).toBeNull(); // a 128-character segment
    expect(activityFileProblem(`${'s'.repeat(128)}/${'s'.repeat(128)}/${'s'.repeat(128)}/${'s'.repeat(125)}`)).toBeNull(); // 512 bytes
  });

  test('refuses dot segments, empty segments, non-ASCII, control characters, too long', () => {
    for (const file of ['.', '..', 'a/./b', 'a/../b', '/a', 'a/', 'a//b', 'a b/c', 'a/mâtériel.md', `a/${'s'.repeat(129)}`, `${'s'.repeat(128)}/${'s'.repeat(128)}/${'s'.repeat(128)}/${'s'.repeat(126)}`, 'a\tb']) {
      expect(activityFileProblem(file)).not.toBeNull();
    }
  });
});

describe('the activity marker grammar', () => {
  test('accepts a marker with exactly one package and one version slot', () => {
    expect(activityMarkerProblem('release: <package>@<version>')).toBeNull();
    expect(activityMarkerProblem('<package> <version>')).toBeNull();
    expect(activityMarkerProblem('<version> then <package>')).toBeNull();
  });

  test('refuses a missing or doubled slot, empty, non-ASCII, a control character, too long', () => {
    expect(activityMarkerProblem('release: <package>')).not.toBeNull();
    expect(activityMarkerProblem('release: <version>')).not.toBeNull();
    expect(activityMarkerProblem('<package>@<package>@<version>')).not.toBeNull();
    expect(activityMarkerProblem('<package>@<version>@<version>')).not.toBeNull();
    expect(activityMarkerProblem('no slots')).not.toBeNull();
    expect(activityMarkerProblem('')).not.toBeNull();
    expect(activityMarkerProblem('<package>@<version> é')).not.toBeNull();
    expect(activityMarkerProblem('<package>@<version>\t')).not.toBeNull();
    expect(activityMarkerProblem(`<package>@<version>${'x'.repeat(181)}`)).toBeNull(); // 200 bytes
    expect(activityMarkerProblem(`<package>@<version>${'x'.repeat(182)}`)).not.toBeNull(); // 201
  });
});
