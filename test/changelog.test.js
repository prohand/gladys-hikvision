// -----------------------------------------------------------------------------
// The changelog roll of the Release workflow (.github/scripts/changelog-release.mjs).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollChangelog } from '../.github/scripts/changelog-release.mjs';

const REPO = 'https://github.com/prohand/gladys-hikvision';

test('the first release moves Unreleased under the version and links its tag', () => {
  const before = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Cameras.\n\n[Unreleased]: ${REPO}/commits/main\n`;
  const after = rollChangelog(before, '1.0.0', '2026-10-14');
  assert.match(
    after,
    /## \[Unreleased\]\n\n## \[1\.0\.0\] - 2026-10-14\n\n### Added\n\n- Cameras\./,
  );
  assert.match(after, new RegExp(`\\[Unreleased\\]: ${REPO}/compare/v1\\.0\\.0\\.\\.\\.HEAD`));
  assert.match(after, new RegExp(`\\[1\\.0\\.0\\]: ${REPO}/releases/tag/v1\\.0\\.0`));
});

test('a later release compares with the previous tag; an empty one says so', () => {
  const before = `## [Unreleased]\n\n## [1.0.0] - 2026-10-14\n\n- x\n\n[Unreleased]: ${REPO}/compare/v1.0.0...HEAD\n`;
  const after = rollChangelog(before, '1.0.1', '2026-10-15');
  assert.match(
    after,
    /## \[1\.0\.1\] - 2026-10-15\n\n- Maintenance release, no functional change\./,
  );
  assert.match(after, new RegExp(`\\[1\\.0\\.1\\]: ${REPO}/compare/v1\\.0\\.0\\.\\.\\.v1\\.0\\.1`));
  assert.equal(rollChangelog(after, '1.0.1', '2026-10-16'), after, 'never twice');
});
