// Where a live run store lives: `<home>/.config/teamcli/<entity>`. The entity names one team's
// store; it is a single path segment and never a path.

import { join } from 'node:path';

export function liveStoreRoot(home: string, entity: string): string {
  if (entity === '' || entity === '.' || entity === '..' || /[\\/\u0000-\u001f]/.test(entity)) {
    throw new Error(`the store entity must be one path segment, not "${entity}"`);
  }
  return join(home, '.config', 'teamcli', entity);
}
