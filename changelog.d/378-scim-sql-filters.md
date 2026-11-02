### Changed
- **SCIM user lookups are faster for large organizations.** `GET /scim/v2/Users` now
  filters (`userName eq` / `externalId eq`) and pages (`startIndex` / `count`) in the
  database, instead of loading every user in the connection's scope and filtering in
  memory. The single-user lookups identity providers run during every sync are now
  indexed. Results, ordering, `totalResults`, and filter matching rules are unchanged.
