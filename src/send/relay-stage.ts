// The relay package's acting calls, behind the warm send host's effect guard at their own boundary
// (rfc-bus-send-server §2.5; review round 1, finding 1): `stage` writes the staged copy and
// `deliver` stages and dials. Every module the hosted line can reach calls the package's acting
// functions through these two wrappers, never directly; test/host/effect-inventory.test.ts holds
// every closure import of the package to that. `capabilities` and the constants are pure.
//
// E7b revision 3: these two wrappers are also where a copy's container is decided by the record's
// era. A stamped (lvl 3) record's copy is written only into the seat's stamped folder
// (src/queue/mail-tree.ts), whatever folder the caller named; one with no stamped folder is refused.
import { deliver, stage, type CopyTarget } from '../../packages/relay/index.js';
import { hostedCommit } from '../host/request-scope.ts';
import { NO_STAMPED_FOLDER, recordFolderFor } from '../queue/mail-tree.ts';
import { isStampedPayload } from './record.ts';

/** Whether a record's text is a signed envelope carrying the stamp. Anything else (a plain-text
 *  drop, a text that does not parse) carries no stamp. */
export function stampedRecordText(record: unknown): boolean {
  if (typeof record !== 'string') return false;
  try {
    const parsed = JSON.parse(record) as { payload?: unknown } | null;
    const payload = parsed !== null && typeof parsed === 'object' ? parsed.payload : undefined;
    return payload !== null && typeof payload === 'object' && isStampedPayload(payload as { lvl?: unknown });
  } catch {
    return false;
  }
}

/** The copy target in the folder of the record's own era; null when a stamped record has none. A
 *  target the package itself would refuse is passed through for its own refusal. */
function eraCopy(copy: CopyTarget | null | undefined, record: unknown): CopyTarget | null | undefined {
  if (copy === null || typeof copy !== 'object' || typeof copy.dir !== 'string') return copy;
  const dir = recordFolderFor(copy.dir, stampedRecordText(record));
  if (dir === null) return null;
  return dir === copy.dir ? copy : { ...copy, dir };
}

export const relayStage: typeof stage = (copy, message, options) => {
  hostedCommit('relay stage');
  const at = eraCopy(copy, message?.record);
  if (at === null) return Promise.resolve({ outcome: 'refused', reason: NO_STAMPED_FOLDER });
  return stage(at as CopyTarget, message, options);
};

export const relayDeliver: typeof deliver = (target, message, options) => {
  hostedCommit('relay deliver');
  if (target === null || typeof target !== 'object') return deliver(target, message, options);
  const at = eraCopy(target.copy, message?.record);
  if (at === null) return Promise.resolve({ route: target.route, outcome: 'refused', reason: NO_STAMPED_FOLDER });
  return deliver(at === target.copy ? target : { ...target, copy: at as CopyTarget }, message, options);
};
