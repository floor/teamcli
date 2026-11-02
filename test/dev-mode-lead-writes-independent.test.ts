import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./dev-mode-lead-writes-independent-cases.ts'));
