import { CODEX_PUSH_ADAPTER } from './push-adapters/codex.ts';
import type { RuntimePushAdapter } from './push.ts';

/**
 * The runtime-push adapters this build carries.
 */
export const RUNTIME_PUSH_ADAPTERS: readonly RuntimePushAdapter[] = [
  CODEX_PUSH_ADAPTER,
];
