-- SCIM externalId uniqueness per connection (#253 Task 6 review).
--
-- Okta pairs users during import by externalId; two users sharing one
-- externalId on the same connection would break that pairing, so the pair is
-- enforced UNIQUE at the schema level (storage maps the violation to a
-- CONFLICT, the SCIM surface to 409 uniqueness). Partial index: NULL
-- externalIds (rows adopted before the IdP assigned one) stay unconstrained,
-- and the same externalId may exist on DIFFERENT connections — IdP namespaces
-- are independent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_members_external_id
  ON scim_members(connection_id, scim_external_id)
  WHERE scim_external_id IS NOT NULL;
