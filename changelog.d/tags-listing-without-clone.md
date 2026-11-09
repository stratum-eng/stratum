### Fixed
- **The tags page and `GET /api/projects/:namespace/:slug/tags` took several
  seconds on every request.** Listing tags cloned the repository each time, even
  one with no tags. Tags are now read from the repository's ref advertisement.
  The message, tagger and date of an annotated tag are read once, by cloning,
  the first time that tag is listed, and are kept after that.
