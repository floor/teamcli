import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./dev-mode-owner-reserved-independent-cases.ts'));
