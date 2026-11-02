### Fixed
- **The test suite passes on every Node version `engines` claims to support.** Opening an
  issue was the one place in `src/` that used numbered SQL parameters (`?1`, `?9`), which
  `node:sqlite` — the engine behind the D1 test harness — cannot bind on older 22.x
  releases: on 22.14.0 the statement throws `column index out of range`, taking 43 tests
  red on a clean checkout while CI's floating `node-version: "22"` resolved to a newer
  release and stayed green. The statement now uses anonymous `?` placeholders and binds
  the three reused values twice, which every 22.x binds and D1 has always accepted. A new
  `Unit Tests (engines floor)` PR check runs the whole suite at exactly the declared
  floor (22.13.0) so the supported range cannot drift silently again, and a `.nvmrc`
  points `nvm use` at a supported major.
