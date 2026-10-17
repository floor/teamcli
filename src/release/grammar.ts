// The grammars of the `releases:` section and of `team release check`'s argument, in one place so
// the section and the command cannot drift apart: a package the file accepts is a package the
// command accepts, and the version argument is the SemVer 2.0.0 grammar the checks are read against.

/** An npm package name: an optional scope, then the name; lowercase ASCII, npm's own shape. */
export const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** npm's length limit on a package name, in bytes. */
export const PACKAGE_BYTES = 214;

const GITHUB_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';

/** A GitHub `owner/repo`: exactly two slash-separated segments. */
export const GITHUB_PATTERN = new RegExp(`^${GITHUB_SEGMENT}/${GITHUB_SEGMENT}$`);

// Semantic Versioning 2.0.0 (semver.org/spec/v2.0.0): decimal integers without leading zeros,
// dot-separated prerelease and build identifiers, numeric prerelease identifiers without leading
// zeros. No leading `v` — the tag and the release carry that, the version does not.
const CORE = '(?:0|[1-9][0-9]*)';
const PRERELEASE_IDENT = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
const BUILD_IDENT = '[0-9a-zA-Z-]+';
export const SEMVER_PATTERN = new RegExp(
  `^${CORE}\\.${CORE}\\.${CORE}` +
    `(?:-${PRERELEASE_IDENT}(?:\\.${PRERELEASE_IDENT})*)?` +
    `(?:\\+${BUILD_IDENT}(?:\\.${BUILD_IDENT})*)?$`,
);

/** Why a string is not a package name, or null when it is one. */
export function packageProblem(name: string): string | null {
  if (!PACKAGE_PATTERN.test(name)) return 'is not a package name';
  if (new TextEncoder().encode(name).length > PACKAGE_BYTES) return `is over ${PACKAGE_BYTES} bytes`;
  return null;
}

/** True when a valid SemVer version carries a prerelease part (the build part never decides it). */
export function hasPrerelease(version: string): boolean {
  return (version.split('+')[0] as string).includes('-');
}

/**
 * Two valid SemVer versions by precedence (semver.org §11): negative when `a` is older, positive
 * when newer, zero when they have the same precedence — build metadata never decides that. The
 * prerelease list decides a tie on the core: absent outranks present, a numeric identifier is
 * older than an alphanumeric one and compared numerically, two alphanumerics compare by ASCII
 * order, and a list that is a prefix of another is older. Null when either string is not a
 * version: nothing here guesses at a tag that is not one.
 */
export function compareVersions(a: string, b: string): number | null {
  if (!SEMVER_PATTERN.test(a) || !SEMVER_PATTERN.test(b)) return null;
  const split = (version: string): { core: number[]; pre: string[] | undefined } => {
    const bare = (version.split('+')[0] as string);
    const at = bare.indexOf('-');
    const core = (at === -1 ? bare : bare.slice(0, at)).split('.').map(Number);
    return { core, pre: at === -1 ? undefined : bare.slice(at + 1).split('.') };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index++) {
    const delta = (left.core[index] as number) - (right.core[index] as number);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (left.pre === undefined || right.pre === undefined) {
    if (left.pre === right.pre) return 0;
    return left.pre === undefined ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const one = left.pre[index];
    const two = right.pre[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one === two) continue;
    const numeric = (value: string): boolean => /^[0-9]+$/.test(value);
    if (numeric(one) && numeric(two)) return Number(one) < Number(two) ? -1 : 1;
    if (numeric(one) !== numeric(two)) return numeric(one) ? -1 : 1;
    return one < two ? -1 : 1;
  }
  return 0;
}

/** A Linear project ID: a lowercase ASCII UUID in canonical 8-4-4-4-12 form. */
export const LINEAR_PROJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Keychain service name's length limit, in bytes. It is a name, never a key. */
export const KEYCHAIN_SERVICE_BYTES = 255;

// A control character: the C0 range, DEL, or the C1 range.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** Why a string is not a Keychain service name, or null when it is one. */
export function keychainServiceProblem(service: string): string | null {
  if (service === '') return 'is empty';
  if (new TextEncoder().encode(service).length > KEYCHAIN_SERVICE_BYTES) return `is over ${KEYCHAIN_SERVICE_BYTES} bytes`;
  if (CONTROL.test(service)) return 'has a control character';
  return null;
}

/** An activity file's length limit, in bytes, and one path segment's shape. */
export const ACTIVITY_FILE_BYTES = 512;
export const ACTIVITY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Why a string is not a repository-relative activity path, or null when it is one. */
export function activityFileProblem(file: string): string | null {
  // ASCII only, slash-separated; the segment grammar already refuses a `.` or `..` segment.
  if (!/^[\x20-\x7e]*$/.test(file)) return 'is not ASCII';
  if (file === '') return 'is empty';
  if (new TextEncoder().encode(file).length > ACTIVITY_FILE_BYTES) return `is over ${ACTIVITY_FILE_BYTES} bytes`;
  if (file.split('/').some((segment) => !ACTIVITY_SEGMENT.test(segment))) return 'is not a slash-separated path of name segments';
  return null;
}

/** An activity marker's length limit, in bytes. */
export const ACTIVITY_MARKER_BYTES = 200;

/** Why a string is not an activity marker, or null when it is one. */
export function activityMarkerProblem(marker: string): string | null {
  if (!/^[\x20-\x7e]*$/.test(marker)) return 'is not ASCII';
  if (marker === '') return 'is empty';
  if (new TextEncoder().encode(marker).length > ACTIVITY_MARKER_BYTES) return `is over ${ACTIVITY_MARKER_BYTES} bytes`;
  if (CONTROL.test(marker)) return 'has a control character';
  if (marker.split('<package>').length !== 2) return 'must have exactly one <package>';
  if (marker.split('<version>').length !== 2) return 'must have exactly one <version>';
  return null;
}
