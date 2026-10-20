import { CODEX_PUSH_ADAPTER } from './push-adapters/codex.ts';
import type { RuntimePushAdapter } from './push.ts';

export {
  CODEX_NATIVE_ROUTE,
  CODEX_NATIVE_TIMEOUT_MS,
  CODEX_PREPROBE_TIMEOUT_MS,
  CODEX_RECEIPT_TIMEOUT_SECONDS,
  codexRelayCapabilities,
  deliverCodexNativeRoute,
  probeCodexLiveReadiness,
  probeCodexNativeRoute,
  queryCodexAppServerThreadRead,
  receiptSecondsFor,
  resolveCodexControlSocketPath,
  resolveCodexEscalationSeconds,
  resolveCodexNativeAttemptTimeoutMs,
  type CodexLiveProbeInput,
  type CodexLiveReadinessOutcome,
  type CodexNativeAttempt,
  type CodexNativeDeliverOptions,
  type CodexNativeMessage,
  type CodexNativeProbeInput,
  type CodexNativeProbeOutcome,
  type CodexNativeTarget,
  type CodexRelayCapabilities,
  type CodexThreadActiveFlag,
  type CodexThreadReadProbe,
  type CodexThreadReadResult,
  type CodexThreadReadSnapshot,
  type CodexThreadStatus,
  type ResolvedCodexAttemptBudget,
} from './push-adapters/codex-relay.ts';

/**
 * The runtime-push adapters this build carries.
 */
export const RUNTIME_PUSH_ADAPTERS: readonly RuntimePushAdapter[] = [
  CODEX_PUSH_ADAPTER,
];
