# Sampled disagreement diagnostic candidate

`initialDisagreementPlan`, `resetDisagreementPlan`, and `observeDisagreementPlan` implement a pure,
unconnected settling helper. They do not select status, log, change permission gates/episodes,
publish, capture, wake, type, read a clock or establish authentication. Existing status and
presence code is unchanged. Retain typed frozen state from this API, not provider payloads.

Context is exactly `{seatId, incarnation}` with 1–64 ASCII letters/digits/period/underscore/colon/
hyphen. Only explicit reset changes it and clears the interval. Reset time cannot regress;
same-context reset retains sequence, while a changed context starts its cursor at zero. There
is no deduplication claim across reset, state loss, restart or replay.

Each observation is exactly `{context, seq, now, winner, other}`. Input seq is a strictly advancing
positive safe integer (gaps allowed); now is a nonnegative safe integer in one monotonic domain,
not a provider timestamp. Missing/foreign/malformed/stale/regressing input changes nothing.
Readings are explicit null for missing, or exactly `{source, word, healthy, current}`. Sources
native/host/screen must differ; both booleans are required. Words are normalized diagnostic
inputs: working, quiet, gated, blocked, unknown, unreachable, exited. No canonical presence or
dispatch meaning is inferred. Prompt kinds, raw rules/events/payloads and terminal text are
unsupported fields. The caller selects the winner and authenticates/correlates readings.

Two healthy/current readings with different words start an ordered source/word fingerprint.
Repeated identical conflict preserves its first time. On a fresh eligible sample at >=2000ms,
one diagnostic is emitted and repeats are suppressed. A different source pair, selected winner,
or word starts a fresh interval. Agreement, explicit missing readings, or health/current loss
clears continuity. Refused input cannot reset or extend it. Time passage alone cannot emit:
there is no tick/timer API. Deadline overflow refuses atomically without advancing state.

State holds one nullable fingerprint and first-time/emitted markers; output is zero or one
descriptor. Diagnostics contain only bounded context, normalized source/word facts, and caller
monotonic since/at values. Every returned nested record is frozen; inputs remain unchanged.
Only own data records with ordinary/null prototypes are accepted. Unknown keys, symbols,
accessors and class/inherited shapes refuse; inspection exceptions yield fixed reasons without
echoing thrown messages or coercing values.

Matching healthy samples establish sampled consistency only. They cannot prove uninterrupted
real-world source health between observations, observer authenticity, current process state,
status-selection correctness or dispatch eligibility. Logging/rotation, signing, persistence,
remote ordering and live adapter integration remain separate work.
