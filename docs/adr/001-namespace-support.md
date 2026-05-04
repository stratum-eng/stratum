# ADR 001: Namespace Support

## Status

Accepted

## Context

Stratum needed a way to organize projects and prevent naming collisions. Projects should be identifiable by both owner (user or organization) and project name.

## Decision

We decided to implement a namespace system with the following characteristics:

### Namespace Format

- **User namespaces**: `@username` (e.g., `@alice`)
- **Organization namespaces**: `org-slug` (e.g., `acme-corp`)

### Project Paths

Projects are identified by: `/{namespace}/{slug}`

Examples:
- `/@alice/my-project`
- `/acme-corp/website`

### Storage

- Double underscore separator for Artifacts repo names: `alice__my-project`
- This prevents collisions between `user-a/b` and `user/a-b`

## Consequences

### Positive

- Clear ownership model
- Prevents naming collisions
- Consistent with GitHub/GitLab patterns
- Supports both users and organizations

### Negative

- Adds complexity to URL routing
- Requires validation of namespace format
- Migration needed for existing projects

## Alternatives Considered

### Flat Project Names

All projects at root level with unique names.

**Rejected:** Would require global uniqueness, difficult for common names like "website" or "api".

### User ID in Path

Use UUIDs: `/user-uuid/project-slug`

**Rejected:** Not user-friendly, hard to remember and share.

### Subdomains

`alice.stratum.dev/project-slug`

**Rejected:** More complex DNS setup, harder to migrate, doesn't solve org problem elegantly.

## Implementation

### URL Parsing

```typescript
// Parse project path
const match = path.match(/^\/(@[^\/]+|[^@][^\/]*)\/(.+)$/);
if (match) {
  const namespace = match[1]; // @alice or acme-corp
  const slug = match[2];      // my-project
}
```

### Validation

```typescript
function isValidNamespace(ns: string): boolean {
  if (ns.startsWith("@")) {
    // User namespace: @username
    return /^@[a-z0-9-]+$/.test(ns);
  }
  // Org namespace: org-slug
  return /^[a-z0-9-]+$/.test(ns);
}
```

## Related Decisions

- [ADR 002: Queue-Based Imports](./002-queue-based-imports.md) - Uses namespace for import job identification
- Database schema uses `namespace` and `slug` columns

## References

- [GitHub: Naming repositories and user accounts](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- Implementation: `src/utils/validation.ts`
