// The relay package's staging write, behind the warm send host's effect guard at its own boundary
// (rfc-bus-send-server §2.5): every caller in the send path stages through this one function, so
// a staged relay package is never written before the first effect's check, whoever calls it.
import { stage } from '../../packages/relay/index.js';
import { hostedCommit } from '../host/request-scope.ts';

export const relayStage: typeof stage = (...args) => {
  hostedCommit('relay stage');
  return stage(...args);
};
