### Changed
- **Audit entries about a member name them in `detail.userId`, not `subject`.** Org and
  team membership events now carry the org or team id as `subject`, and SCIM provisioning
  events carry the SSO connection id. Entries written before this release keep the user id
  in `subject`; filter on `detail.userId` to find newer ones.

### Security
- **Account deletion now erases the user from the whole audit log.** Previously only the
  actor was anonymized, so an entry could still name the erased account by id or email as
  its subject or inside its detail. Every such reference is now rewritten to
  `deleted-user`. Migration 061 replaces the append-only trigger so the database allows
  exactly that rewrite, only for an account that is being deleted, and still rejects every
  other edit and every delete.
