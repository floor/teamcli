// Fails when the tagged version's CHANGELOG heading does not carry a real date.
//
// A released version's heading is `## [<version>] - YYYY-MM-DD` until the
// release is dated, and the release's notes are the section's body, never its
// heading — so a tag on a commit that still says YYYY-MM-DD would publish and
// release without a complaint. The release workflow runs this before anything
// publishes; `ci.yml` never does, because between releases the placeholder is
// legitimate. A heading that is missing, or whose tail is not a real date,
// fails; a CHANGELOG.md that cannot be read exits 2.
//
//   bun scripts/check-release-date.ts <version>
import { readFileSync } from 'node:fs';

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

/** A date that exists: `2026-10-05` yes; `2026-02-30` and `2026-13-01`, which Date would roll over, no. */
function isRealDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? NaN, (month ?? NaN) - 1, day ?? NaN));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === (month ?? NaN) - 1 &&
    parsed.getUTCDate() === day
  );
}

/** The section heading and its real date, shared by release preparation checks. */
export function releaseHeadingOf(changelog: string, version: string): { heading: string; date: string | null } | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`^## \\[${escaped}\\](.*)$`, 'm').exec(changelog);
  if (found === null) return null;
  const tail = found[1] ?? '';
  const date = /^ - (\d{4}-\d{2}-\d{2})$/.exec(tail)?.[1];
  return { heading: `## [${version}]${tail}`, date: date !== undefined && isRealDate(date) ? date : null };
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) exit('usage: bun scripts/check-release-date.ts <version>', 2);
  let changelog: string;
  try {
    changelog = readFileSync('CHANGELOG.md', 'utf8');
  } catch (error) {
    exit(`check-release-date: cannot read CHANGELOG.md: ${(error as Error).message}`, 2);
  }
  const section = releaseHeadingOf(changelog, version);
  if (section === null) exit(`check-release-date: CHANGELOG.md has no section for ${version}`, 1);
  if (section.date === null) {
    exit(`check-release-date: the heading for ${version} carries no real date: "${section.heading}"`, 1);
  }
  console.log(`check-release-date: ${version} is dated ${section.date}`);
}
