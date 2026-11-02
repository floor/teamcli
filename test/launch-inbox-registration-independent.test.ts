import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./launch-inbox-registration-independent-cases.ts'));
