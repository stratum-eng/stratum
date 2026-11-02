### Changed
- **SCIM user lookups are faster for large organizations.** `GET /scim/v2/Users` now
  filters (`userName eq` / `externalId eq`) and pages (`startIndex` / `count`) in the
  database, instead of loading every user in the connection's scope and filtering in
  memory. The `userName eq` and `externalId eq` lookups identity providers run during
  every sync now use an index rather than reading the whole scope. Results, ordering, `totalResults`, and filter matching rules are unchanged.
