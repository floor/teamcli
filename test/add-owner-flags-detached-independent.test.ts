import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./add-owner-flags-detached-independent-cases.ts'));
