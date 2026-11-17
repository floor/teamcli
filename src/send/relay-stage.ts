// The relay package's acting calls, behind the warm send host's effect guard at their own boundary
// (rfc-bus-send-server §2.5; review round 1, finding 1): `stage` writes the staged copy and
// `deliver` stages and dials. Every module the hosted line can reach calls the package's acting
// functions through these two wrappers, never directly; test/host/effect-inventory.test.ts holds
// every closure import of the package to that. `capabilities` and the constants are pure.
import { deliver, stage } from '../../packages/relay/index.js';
import { hostedCommit } from '../host/request-scope.ts';

export const relayStage: typeof stage = (...args) => {
  hostedCommit('relay stage');
  return stage(...args);
};

export const relayDeliver: typeof deliver = (...args) => {
  hostedCommit('relay deliver');
  return deliver(...args);
};
