# Stratum UI & Architecture Audit

**Date:** 2026-05-02  
**Branches Audited:** main, feature/ui-improvements-and-private-repos (PR#13)  
**Master Plan Version:** v2

---

## Executive Summary

The codebase is well-structured but has several UI/UX gaps that need addressing before it's ready for users. The main issues are around routing, public access, and the relationship between users, orgs, and projects.

---

## Current Architecture

### Project Scoping: Users vs Orgs

**Current State:** Projects are scoped to **individual users only**, not organizations.

From `src/types.ts`:
```typescript
interface ProjectEntry {
  name: string;
  remote: string;
  token: string;
  createdAt: string;
  ownerId?: string;  // <-- Only user ownership
  visibility?: "private" | "public";
  // No orgId field!
}
```

From `src/utils/authz.ts`:
```typescript
export function canWriteProject(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  if (!project.ownerId) return false;
  return project.ownerId === userId || project.ownerId === agentOwnerId;
}
```

**Gap:** Unlike GitHub where repos are `github.com/:org/:repo`, Stratum currently only supports `stratum.dev/:project` with user ownership. Organizations exist in the DB (`orgs`, `org_members`, `teams` tables) but are NOT linked to projects.

**Master Plan Phase 3.1** specifically mentions: "Expand the simple `org` field on users into proper org/team management. New D1 tables. Repo ownership by org."

---

## Issue #1: Why /ui? Confusing Routing Structure

### Current Routing (`src/index.ts`)

```typescript
app.get("/", (c) => c.redirect("/ui"));  // Root redirects to /ui
app.route("/ui", uiRouter);              // All UI under /ui prefix
```

### Current UI Routes (`src/routes/ui.tsx`)

```text
GET /ui/                      → Dashboard (list projects)
GET /ui/projects              → Dashboard (alias)
GET /ui/projects/:name        → Repo view (files + commits)
GET /ui/projects/:name/files/:path → File viewer
GET /ui/projects/:name/changes → Changes list
GET /ui/projects/:name/workspaces → Workspace list
GET /ui/changes/:id           → Change detail
```

### Problems

1. **Unnecessary /ui prefix** - The entire application is a web UI. The prefix adds no value and makes URLs longer
2. **Inconsistent with GitHub-style URLs** - GitHub uses `github.com/:owner/:repo`, Stratum should follow similar patterns
3. **API and UI routes are separate** - `/api/projects` vs `/ui/projects` is confusing

### Recommended Routing (GitHub-Style)

```text
GET /                         → Dashboard / Home (was /ui/)
GET /:owner/:repo             → Repo view (was /ui/projects/:name)
GET /:owner/:repo/blob/:path  → File viewer (was /ui/projects/:name/files/:path)
GET /:owner/:repo/changes     → Changes list
GET /:owner/:repo/workspaces  → Workspaces list
GET /changes/:id              → Change detail (global namespace)

API routes stay as-is:
GET /api/projects
POST /api/projects
etc.
```

This requires:
1. Differentiating usernames from org slugs in route matching
2. Updating all internal links
3. Handling the case where project names could clash with reserved routes

---

## Issue #2: Public Project Access While Unauthenticated

### Current Behavior

**The good news:** The authorization system already supports public projects!

From `src/utils/authz.ts`:
```typescript
export function canReadProject(
  project: ProjectEntry,
  userId?: string,
  agentOwnerId?: string,
): boolean {
  if (project.visibility === "public") return true;  // <-- Public access works!
  return canWriteProject(project, userId, agentOwnerId);
}
```

From `src/routes/projects.ts`:
```typescript
app.get("/", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  const projects = filterReadableProjects(await listProjects(c.env.STATE), userId, agentOwnerId);
  return ok({ ... });
});
```

### The Problem

1. **API endpoints require auth for listing** - `GET /api/projects` filters by readability but the auth middleware doesn't block unauthenticated access... wait, let me check the auth middleware again.

Looking at `src/middleware/auth.ts`:
```typescript
export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // ...token validation logic...
  // If no token and no session, it just calls next() without setting userId
  await next();
};
```

**The auth middleware is OPTIONAL** - it sets userId if present but doesn't block unauthenticated requests. This is correct design for supporting public projects.

2. **UI routes authorization** ✅ FIXED - UI routes now properly check permissions using `canReadProject()`:
```typescript
app.get("/projects/:name", async (c) => {
  const project = await getProject(c.env.STATE, name);
  if (!project) { return 404; }
  // Now checks permissions with canReadProject
  if (!canReadProject(project, userId, agentOwnerId)) {
    return c.html(<div>Project access denied.</div>, 403);
  }
  // ...
});
```

All UI routes (repo view, file viewer, changes, workspaces) now properly gate access using `filterReadableProjects` for lists and `canReadProject` for individual project access.

3. **No way to set project visibility** - Looking at project creation in `src/routes/projects.ts`:
```typescript
await setProject(c.env.STATE, {
  name: body.name,
  remote: repo.remote,
  token: repo.token,
  createdAt: new Date().toISOString(),
  ownerId: userId,
  // visibility is NOT set - defaults to undefined (treated as private?)
});
```

---

## Issue #3: Organization Support Gaps

### What's Implemented

✅ Org creation and membership (`src/storage/orgs.ts`, `src/routes/orgs.ts`)  
✅ Teams within orgs (`src/storage/teams.ts`)  
✅ Org/Team management APIs

### What's Missing

❌ **Projects cannot be owned by orgs** - Only `ownerId` (user) field exists  
❌ **No org-scoped project URLs** - Can't do `/acme-corp/project-name`  
❌ **Team-based permissions** - Teams exist but can't access projects  
❌ **Org project listing** - No way to list all projects in an org

### Database Migration Needed

```sql
-- Add org ownership to projects
ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES orgs(id);
-- Or if using KV storage for projects, add orgId field to ProjectEntry
```

And update `ProjectEntry` type:
```typescript
interface ProjectEntry {
  name: string;
  remote: string;
  token: string;
  createdAt: string;
  ownerId?: string;      // User owner (for personal projects)
  orgId?: string;        // Org owner (for org projects)
  visibility?: "private" | "public";
}
```

---

## Issue #4: UI/UX Improvements Needed

### Navigation

**Current navbar** (`src/ui/layout.tsx`):
```tsx
<nav class="nav">
  <a class="nav-brand" href="/">stratum</a>
  <div class="nav-links">
    <a href="/ui/projects">projects</a>
  </div>
</nav>
```

**Missing:**
- User authentication status (am I logged in?)
- Login/Logout links
- User profile link
- Organization switcher (when orgs are implemented)
- Search functionality
- Create new project button (in UI)

### Dashboard (`src/ui/pages/home.tsx`)

**Current:** Simple grid of project cards

**Missing:**
- Filter by owner (me vs orgs I'm in)
- Sort options (recent, alphabetical)
- Empty state CTA to create first project
- Public vs private indicators

### Repo View (`src/ui/pages/repo.tsx`)

**Current:** File tree + commit log side by side

**Missing:**
- README rendering (currently only shows file list)
- Branch selector
- Project visibility badge (public/private)
- Owner information
- Last updated timestamp
- Clone URL display
- Settings link (for owners)

### File Viewer (`src/ui/pages/file-viewer.tsx`)

**Current:** Syntax-highlighted code with line numbers (basic implementation with HTML escaping)

**Missing:**
- Advanced syntax highlighting (Shiki/prism.js)
- Raw file view
- Copy to clipboard button
- File history / blame
- Line highlighting via URL hash

### Changes/Pull Requests

**Current:** List and detail pages exist

**Missing:**
- Diff view (currently only shows metadata)
- Inline commenting
- Review workflow UI
- Status transitions (needs visual clarity)

---

## Issue #5: Authentication Flow Gaps

### What's Working

✅ GitHub OAuth (`/auth/github`)  
✅ Email magic link auth (`/auth/email`)  
✅ Session cookies  
✅ API token auth (Bearer tokens)

### What's Missing

❌ **Login page UI** - No `/login` route that renders a login form
❌ **Session-aware UI** - Layout doesn't show login/logout based on auth state
❌ **Protected route handling** - UI routes don't redirect to login when auth required
❌ **User registration UI** - No signup page (only API-based user creation)

Looking at `src/routes/email-auth.tsx`:
```typescript
// Only handles POST /auth/email/send and POST /auth/email/callback
// No GET route to render a login form!
```

---

## Issue #6: API vs UI Consistency

### Current Project Access Patterns

| Operation | API Route | UI Route | Auth Check |
|-----------|-----------|----------|------------|
| List projects | `GET /api/projects` | `GET /ui/` | API: yes, UI: no |
| Get project | `GET /api/projects/:name` | `GET /ui/projects/:name` | API: yes, UI: **NO** |
| List files | `GET /api/projects/:name/files` | Via repo page | API: yes, UI: **NO** |
| View file | Not implemented | `GET /ui/projects/:name/files/:path` | N/A |
| List changes | `GET /api/changes?project=` | `GET /ui/projects/:name/changes` | API: ?, UI: **NO** |

**Critical:** UI routes need to implement the same permission checks as API routes.

---

## Recommendations by Priority

### P0 - Critical (Fix Before Launch)

1. **Fix UI authorization** - Add `canReadProject` checks to all UI routes
2. **Add login/logout UI** - Create login page and update layout with auth status
3. **Fix project visibility** - Allow setting visibility on create, default to private

### P1 - High (Core UX)

4. **Remove /ui prefix** - Serve UI from root paths using GitHub-style URLs (`/:owner/:repo`)
5. **Add README rendering** - Show rendered README on repo page
6. **Add create project UI** - Button/form to create projects from the dashboard
7. **Add user profile dropdown** - Show current user, link to settings, logout

### P2 - Medium (Feature Complete)

8. **Link orgs to projects** - Add org ownership support
9. **Implement team permissions** - Teams can access org projects
10. **Add diff viewer** - Show actual code diffs in changes
11. **Enhance syntax highlighting** - Use Shiki or similar for file viewer (basic highlighting already implemented)

### P3 - Polish

12. **Search functionality** - Project and code search
13. **File history/blame** - Git history for files
14. **Settings pages** - Project and user settings UI
15. **Responsive improvements** - Mobile-friendly layout

---

## Alignment with Master Plan

| Feature | Master Plan Phase | Current Status |
|---------|------------------|----------------|
| Basic UI (Hono JSX) | 1c | ✅ Complete |
| File browser | 1c | ✅ Complete |
| Change detail | 1c | ✅ Complete |
| Syntax highlighting | 2.8 | 🟡 Basic (line numbers + HTML escape) |
| Diff viewer | 2.8 | ❌ Not started |
| OAuth login | 2.1 | ✅ Complete |
| Email auth | N/A (added later) | ✅ Complete |
| Org/team management | 3.1 | 🟡 Partial (APIs only) |
| GitHub-style URLs | N/A | ❌ Not started |
| Public/private projects | 1a | 🟡 Partial (auth only) |

---

## Immediate Action Items

1. **Security fix:** Add permission checks to UI routes in `src/routes/ui.tsx`
2. **UX fix:** Create `/login` page with email and GitHub options
3. **Route improvement:** Move UI from `/ui/*` to root paths
4. **Feature:** Add project visibility toggle to creation flow
5. **Data model:** Connect projects to orgs (add orgId field)

---

## Questions for Product Owner

1. **URL structure:** Should we adopt full GitHub-style URLs (`/:owner/:repo`) or keep flat project names (`/:project`)?
2. **Public projects:** Should anonymous users see a different dashboard, or the same with public projects only?
3. **Org priority:** Is org-scoped projects a launch blocker, or can we ship with user-scoped only?
4. **Default visibility:** Should new projects default to public (open source) or private?
5. **Landing page:** Should `/` be the dashboard (when logged in) or a marketing landing page?
