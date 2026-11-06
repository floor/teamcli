import type { TeamFile } from './types.ts';

/** Display names from a validated file: the home supplies inheritance; served projects do not. */
export function membershipsOfFile(file: Pick<TeamFile, 'inProject' | 'alsoIn'>): { home: string | null; served: string[] } {
  return { home: file.inProject, served: [...(file.alsoIn ?? [])] };
}
