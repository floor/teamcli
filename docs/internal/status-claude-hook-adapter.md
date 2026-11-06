# Conditional Claude hook parser candidate

**Real-capture acceptance is incomplete.** No versioned captured positive hook input was supplied.
The fixture directory records repository measured history separately; every positive parser/
reducer test is synthetic. A passing test is not a deployed adapter/support claim.

Official schema research accessed 2026-11-06: [hook reference](https://code.claude.com/docs/en/hooks),
especially common input fields, PreToolUse/PostToolUse, PermissionRequest, Notification,
SubagentStart/Stop, Stop and SessionEnd. Tool hooks identify a tool_use_id; PermissionRequest
explicitly lacks it. Notification's type/text alone does not correlate a particular gate.

`adaptClaudeHook(jsonText, envelope)` accepts primitive JSON text up to 65536 UTF-8 bytes.
Object payloads are refused without invoking getters. Duplicate top-level keys, nonfinite or
unsafe-magnitude JSON numbers and malformed critical fields refuse. Unsupported events/schema
additions remain unsupported; known irrelevant body/path fields are ignored, never followed or
echoed. No IO, hook stdin, clock, transcript, environment, install or live wiring occurs.

Caller envelope requires explicit reducer-safe seatId, incarnation, mainTurn, lane and positive
safe seq, plus exact expected opaque sessionId and promptId. It may additionally supply agentId,
toolUseId, gateId and binding. Missing evidence is correlation-unproven. Own data fields only;
accessors/unknown fields/inspection exceptions refuse. These syntax checks are not authentication:
the caller must separately establish current launch, prompt-to-turn mapping, lane and sequence.
Provider session/prompt IDs never default any native identity or source sequence.

Every normalized event requires matching provider session_id/prompt_id. Main lane rejects an
agent_id; subagent lane requires an explicit matching agentId. Provider identifiers are compared
literally within 256 characters, without trimming/hashing/normalization. A tool_use_id copied to
native toolId must fit its 1–64 ASCII token contract, else identifier-contract is unsupported.
Native tokens allow letters/digits/period/underscore/colon/hyphen; the reducer is not widened.

| Hook | Conditional normalized result |
| --- | --- |
| UserPromptSubmit | Main turn-start |
| PreToolUse | Main tool-start, or explicitly correlated subagent activity |
| PostToolUse | Main tool-end only with matching toolUseId and explicit gateId/binding; subagent activity cannot clear main gate |
| Stop | Main candidate-state unknown; no gate/clear inference |
| SubagentStart/Stop | Explicitly correlated subagent activity only |
| SessionEnd | Main session-end; process confirmation still needed |
| Notification permission_prompt / PermissionRequest | Correlation-unproven; no fabricated tool/gate link |
| Other notification / event | Ignored notification or unsupported event |

Tool input objects and tool response presence are shape-checked; their contents cannot grant
permission. Stop requires its boolean flag, and SessionEnd requires a known reason. SessionEnd
without prompt correlation remains unproven. Native reducer still checks active seat/incarnation/
turn/gate/tool/binding and source-sequence continuity. Incorrect gate bindings preserve its gate.

Output is one frozen scalar-only native observation, or a fixed value-free refusal. It cannot
establish/reset identity, lower owner-required, authorize capture/wake/type, or prove process exit.
Collector correlation and captured-schema provenance remain separate required evidence. No live
hook installation, ingest, source selection, signing, persistence, dispatch or Codex adapter.
