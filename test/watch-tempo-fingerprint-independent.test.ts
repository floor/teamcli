import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./watch-tempo-fingerprint-independent-cases.ts'));
