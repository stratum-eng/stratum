### Fixed
- **`npm run release:prepare` now bumps `package-lock.json` along with `package.json`.**
  The lockfile's root `version` and `packages[""].version` were never updated, so they
  fell one release further behind on every cut. Only those two fields are edited;
  dependencies are not re-resolved. `npm run release:check` (which the Release
  workflow runs) now fails when either lockfile version disagrees with
  `package.json`.
