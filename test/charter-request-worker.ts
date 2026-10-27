// One overlapping owner-seat request. The parent holds the lock until both waiters exist.
import { writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { createOwnerActionRequest, type OwnerAction } from '../src/client/owner-action.ts';

const data = workerData as {
  home: string;
  root: string;
  action: OwnerAction;
  requestedBy: string;
  opened: string;
};

const result = createOwnerActionRequest(
  data.home,
  {
    actions: [data.action],
    root: data.root,
    team: 'acme',
    head: null,
    args: { [data.action]: [] },
    requestedBy: data.requestedBy,
  },
  new Date('2026-10-26T12:00:00.000Z'),
  () => {
    writeFileSync(data.opened, 'opened\n');
  },
);

parentPort?.postMessage(result);
