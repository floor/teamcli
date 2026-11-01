import { independentHomeSuite } from './independent-home-fixture.ts';
await independentHomeSuite(import.meta.path, () => import('./answer-question-independent-cases.ts'));
