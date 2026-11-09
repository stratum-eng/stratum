### Fixed
- **The tags page and `GET /api/projects/:namespace/:slug/tags` took several
  seconds on every request.** Listing tags cloned the repository each time, even
  one with no tags. Tag names are now read from the repository's ref
  advertisement. A tag is read by cloning once, the first time it is listed, and
  remembered after that, so only the first request after a new tag is pushed is
  slow.

### Added
- **The tags endpoint is documented** in the API reference and the OpenAPI
  spec.
