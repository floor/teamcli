import { independentHomeSuite } from './launched-team-writers-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./launched-team-writers-independent-cases.ts'));
