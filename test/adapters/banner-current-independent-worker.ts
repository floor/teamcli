import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
const [expectedHome, encoded] = process.argv.slice(2);
if (!expectedHome || !encoded || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const { bannerModel, signedSeatModel, modelDiffers } = await import('../../src/status/statusline.ts');
const screen = JSON.parse(encoded) as string | null;
const declared = { cli: 'claude-code', model: 'GLM', version: '5.3', launch: '/synthetic/wrappers/claude-glm' };
const model = signedSeatModel(declared, screen ?? undefined);
console.log(JSON.stringify({ home: homedir(), banner: bannerModel(screen ?? undefined), model, drift: model !== null && modelDiffers(model, declared) }));
