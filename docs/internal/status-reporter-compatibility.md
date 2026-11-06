# Reporter compatibility candidate

`classifyReporterCompatibility(expected, observed, supportedVersions?)` is a pure metadata
classifier. It has no production version map, IO, hooks, ingest, status display or dispatcher.

Expected metadata supplies `seatId`, `incarnation`, `cli`, `profile`, and positive safe-integer
`reporterVersion`. Observed metadata must match all four context tokens before comparison.
Tokens are 1–64 characters from letters, digits, period, underscore, colon and hyphen. Optional
`cliVersion` is opaque visible ASCII of length 1–128; it never determines reporter protocol.
Own data records with ordinary or null prototypes are accepted. Unknown keys, accessors,
class instances and malformed values refuse without echoing input or propagating exceptions.

| Protocol comparison | Classification | Compatibility |
| --- | --- | --- |
| Equal | current | Compatible only if included in support set |
| Lower | obsolete | Compatible only if explicitly included |
| Higher | newer | Always unsupported |
| Missing observation, context or protocol version | unknown | Unproven |
| Foreign context or malformed metadata | refused | Unproven |

The default support set contains only the expected protocol version. Explicit support is a dense
array of at most 64 unique positive safe integers, with no extra properties or accessors. Empty
means none supported. Omitting the expected version can yield current/unsupported. A newer
version stays unsupported even if listed. No range object is accepted or expanded implicitly.

The output is a frozen flat record of closed enums plus validated numeric protocol facts or
null. Refusals contain no numeric facts. Drift and compatibility are separate: an obsolete
reporter may be explicitly compatible without being current. Compatibility does not establish
schema/event coverage, observer authentication, current presence, process exit, or authorization
to ingest, dispatch, fallback, repair or reload. Future adapters must enforce those boundaries.
