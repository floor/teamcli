# Delayed-observation plan candidate

This pure, unconnected planner proposes bounded observation deadlines. It reads no clock and
performs no timer, capture, process, wake, typing, network or persistence operation. Existing live
status scheduling is unchanged. A descriptor grants no authority to read a seat.

Keep the frozen state returned by `initialProbePlan`, `resetProbePlan`, and `reduceProbePlan`.
Reset supplies exact `{seatId, incarnation, mainTurn, step}` and monotonic integer `now`.
Context tokens are 1–64 ASCII letters/digits/period/underscore/colon/hyphen. Only explicit reset
changes context and clears work; same-context reset retains sequence and one-shot retirement
markers, while different-context reset starts fresh cursors. Time cannot regress across resets.

Every input has `context`, positive safe-integer `seq`, nonnegative safe-integer `now`, `lane`
main/subagent, and closed `kind`. Main input needs explicit eligibility flags `human:false`,
`protected:false`, `stopped:false`, `supportsCapture:true`. Missing flags deny and cancel work.
Malformed metadata, foreign context, stale sequences and regressing time refuse unchanged.
Correlated subagent observations advance only the sequence/time cursor, preserving the main
plan without applying their eligibility or semantic effects. Older main input then stays stale.

| Kind | Extra input | Effect on eligible active step |
| --- | --- | --- |
| tool-start / turn-stop | boolean partialCoverage | Partial coverage arms +250/+1000/+3000 once |
| completion / permission-clear | none | Cancel pending work and retire this step |
| heartbeat / other | none | Preserve pending work |
| classify | none | One immediate dueAt=now proposal; retain earlier outstanding request |
| output | outputSeq, mode, since, partialCoverage | Advancing output may propose +300 debounce |
| consume | none | Emit and remove due work, preserving future deadlines |

Output mode is quiet/working/unknown. `since` is the explicit quiet-start or last correlated
activity time, within this context's monotonic interval, no later than now and nondecreasing
across output facts. Quiet qualifies after >=500ms; working only with partial coverage after
>=3000ms. Unknown mode and output sequence alone do not qualify. Duplicate output cannot rearm;
regression refuses. Repeated output never postpones an outstanding deadline. Late output can
request a probe after the staggered deadlines were consumed; a retired step cannot rearm.

An immediate proposal can be consumed at the same time with a later input sequence. Consume
coalesces exactly coincident deadlines and retains distinct deadlines/remaining work. There are
at most five pending slots (three staggered, one output, one classification) and five descriptors
per consume. Repeating consume emits nothing already removed. There is no fallback cadence.
Arithmetic overflow refuses the whole input unchanged.

Only own data records with ordinary/null prototypes are accepted. Unknown fields (including
symbols/non-enumerable extras), accessors and malformed shapes refuse; inspection exceptions
never echo their messages. No arbitrary payload or provider string is accepted. State, nested
records/arrays, descriptors and results are frozen. Reasons are closed; descriptors contain only
the bounded context, numeric dueAt and closed causes. Input metadata and prior state are unchanged.

Caller context equality and eligibility facts are local consistency checks. A future executor
must independently recheck current identity, ownership and eligibility before capture. Synthetic
deadlines do not establish provider correlation, a deployed modal reproduction, prompt state,
permission clearance, process exit, authentication or dispatch authority.
