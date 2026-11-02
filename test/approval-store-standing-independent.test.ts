import { independentHomeSuite } from './approval-store-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./approval-store-standing-independent-cases.ts'));
