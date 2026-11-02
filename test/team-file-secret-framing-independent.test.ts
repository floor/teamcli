import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./team-file-secret-framing-independent-cases.ts'));
