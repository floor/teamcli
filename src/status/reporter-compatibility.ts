/** Pure launch/reporter metadata comparison. No authentication, ingest, or runtime action. */
export type ExpectedReporterContext = {
  readonly seatId: string;
  readonly incarnation: string;
  readonly cli: string;
  readonly profile: string;
  readonly reporterVersion: number;
  readonly cliVersion?: string;
};

export type ReporterObservation = Partial<ExpectedReporterContext>;

export type ReporterCompatibility = Readonly<{
  classification: 'current' | 'obsolete' | 'newer' | 'unknown' | 'refused';
  compatibility: 'compatible' | 'unsupported' | 'unproven';
  reason:
    | 'versions_equal'
    | 'reporter_older'
    | 'reporter_newer'
    | 'missing_observation'
    | 'missing_context'
    | 'missing_version'
    | 'context_mismatch'
    | 'malformed_expected'
    | 'malformed_observation'
    | 'malformed_supported_versions'
    | 'malformed_metadata';
  expectedVersion: number | null;
  observedVersion: number | null;
}>;

type Reason = ReporterCompatibility['reason'];
const CONTEXT = ['seatId', 'incarnation', 'cli', 'profile'] as const;
const FIELDS = new Set<string>([...CONTEXT, 'reporterVersion', 'cliVersion']);

/**
 * Compare explicit protocol versions after all four launch-context tokens match. The optional
 * array is an exact support set, not a range or a claim about every event in a protocol.
 * Newer-than-expected reporters remain unsupported even if listed. No deployed map is inferred.
 */
export function classifyReporterCompatibility(
  expected: unknown,
  observed: unknown,
  supportedVersions?: unknown,
): ReporterCompatibility {
  try {
    const launch = dataRecord(expected);
    if (
      launch === null || CONTEXT.some((key) => !isToken(launch[key])) ||
      !isVersion(launch.reporterVersion) || !validBuildVersion(launch.cliVersion)
    ) return refused('malformed_expected');

    const supported = supportSet(supportedVersions, launch.reporterVersion);
    if (supported === null) return refused('malformed_supported_versions');
    if (observed === undefined || observed === null) {
      return result('unknown', 'unproven', 'missing_observation', launch.reporterVersion, null);
    }
    const reporter = dataRecord(observed);
    if (
      reporter === null ||
      CONTEXT.some((key) => reporter[key] !== undefined && !isToken(reporter[key])) ||
      (reporter.reporterVersion !== undefined && !isVersion(reporter.reporterVersion)) ||
      !validBuildVersion(reporter.cliVersion)
    ) return refused('malformed_observation');

    const version = isVersion(reporter.reporterVersion) ? reporter.reporterVersion : null;
    if (CONTEXT.some((key) => reporter[key] === undefined)) {
      return result('unknown', 'unproven', 'missing_context', launch.reporterVersion, version);
    }
    if (CONTEXT.some((key) => reporter[key] !== launch[key])) return refused('context_mismatch');
    if (version === null) {
      return result('unknown', 'unproven', 'missing_version', launch.reporterVersion, null);
    }
    if (version > launch.reporterVersion) {
      return result('newer', 'unsupported', 'reporter_newer', launch.reporterVersion, version);
    }
    return result(
      version === launch.reporterVersion ? 'current' : 'obsolete',
      supported.has(version) ? 'compatible' : 'unsupported',
      version === launch.reporterVersion ? 'versions_equal' : 'reporter_older',
      launch.reporterVersion,
      version,
    );
  } catch {
    // Unknown objects can throw during prototype/key/descriptor inspection. Never echo errors.
    return refused('malformed_metadata');
  }
}

/** Snapshot only own data properties; never invoke metadata getters. */
function dataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > FIELDS.size) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !FIELDS.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function supportSet(value: unknown, expected: number): Set<number> | null {
  if (value === undefined) return new Set([expected]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 64) return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const versions = new Set<number>();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || !isVersion(descriptor.value)) return null;
    if (versions.has(descriptor.value)) return null;
    versions.add(descriptor.value);
  }
  return versions;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 &&
    !/[^A-Za-z0-9._:-]/.test(value);
}

function validBuildVersion(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length >= 1 &&
    value.length <= 128 && !/[^\x21-\x7e]/.test(value));
}

function refused(reason: Reason): ReporterCompatibility {
  return result('refused', 'unproven', reason, null, null);
}

function result(
  classification: ReporterCompatibility['classification'],
  compatibility: ReporterCompatibility['compatibility'],
  reason: Reason,
  expectedVersion: number | null,
  observedVersion: number | null,
): ReporterCompatibility {
  return Object.freeze({ classification, compatibility, reason, expectedVersion, observedVersion });
}
