# Stratum TODO List

## 🔐 Authentication & Authorization

### 1. Magic Link Authentication (HIGH PRIORITY - ✅ COMPLETE)
- [x] Research current auth system
- [x] Create `/auth/email` endpoint to request magic link
  - [x] Accept email address from user
  - [x] Generate unique magic link token (32-byte secure random)
  - [x] Store token in KV with expiration (15 min)
  - [x] Send email via Cloudflare Email binding
  - [x] Create email template for magic link (built into endpoint)
- [x] Create `/auth/email/verify` endpoint to verify magic link
  - [x] Validate token from URL
  - [x] Look up user by email or create new user
  - [x] Create session
  - [x] Set session cookie
  - [x] Redirect to dashboard
- [x] Create `/auth/email` UI page
  - [x] Email input form
  - [x] "Check your email" confirmation state
  - [x] Error handling
- [x] Add rate limiting for magic link requests (5 per hour per email)
- [x] Write tests for magic link flow
- [x] Address CodeRabbit security review comments
  - [x] Hash email in rate limit key (PII protection)
  - [x] Add try/catch around rate limit KV read (fail open)
  - [x] Validate redirect cookie (prevent open redirect)

### 2. Session Management Improvements
- [ ] Add session refresh endpoint
- [ ] Implement session invalidation on logout from all devices
- [ ] Add "Remember me" option (30 days vs 1 day session)

## 📧 Email System

### 3. Email Templates
- [ ] Create HTML email template for magic links
- [ ] Create plain text fallback
- [ ] Style with Stratum branding

## 🎯 Core Features

### 4. Project Import Enhancements
- [ ] Complete Git sync functionality (started in Option B)
  - [ ] Sync UI with progress indicator
  - [ ] Conflict resolution UI
  - [ ] Auto-sync on schedule (optional)
- [ ] Bulk import improvements
  - [ ] Add UI for bulk import
  - [ ] Support CSV upload
  - [ ] Progress tracking for batch jobs
- [ ] Template system
  - [ ] Create project from template UI
  - [ ] Template gallery

### 5. Multi-Provider Support (GitLab/Bitbucket)
- [ ] Add provider-specific OAuth flows
- [ ] Add provider icons in UI
- [ ] Handle provider-specific errors

## 🔍 Observability

### 6. Monitoring Dashboard
- [ ] Create admin metrics dashboard UI
- [ ] Add real-time queue depth visualization
- [ ] Add import success/failure rate charts
- [ ] Set up alerting thresholds

## 🧪 Testing

### 7. Test Coverage Improvements
- [ ] Add tests for git provider implementations
- [ ] Add integration tests for queue processing
- [ ] Add smoke tests for critical paths
- [ ] Achieve 80% test coverage

## 🔒 Security

### 8. Security Hardening
- [ ] Add CSRF protection
- [ ] Add rate limiting for all endpoints
- [ ] Implement API key rotation
- [ ] Add audit logging for sensitive operations
- [ ] Security headers review

## 📝 Documentation

### 9. Documentation Improvements
- [ ] API reference with examples
- [ ] Troubleshooting guide for common errors
- [ ] Architecture diagrams
- [ ] Deployment guide for self-hosting

## 🚀 Performance

### 10. Performance Optimizations
- [ ] Add caching for project listings
- [ ] Optimize D1 queries with proper indexing
- [ ] Lazy load git provider implementations
- [ ] Add CDN caching for static assets

## 🎨 UI/UX

### 11. UI Improvements
- [ ] Dark mode support
- [ ] Mobile responsive design
- [ ] Loading states for all async operations
- [ ] Error boundary for crash recovery
- [ ] Keyboard shortcuts

## 🔄 DevOps

### 12. CI/CD Improvements
- [ ] Add integration tests to PR pipeline
- [ ] Set up staging environment auto-deploy
- [ ] Add performance benchmarks
- [ ] Add bundle size monitoring

## 🐛 Known Issues

### 13. Bug Fixes
- [ ] Fix TypeScript strict mode errors
- [ ] Fix race conditions in import cancellation
- [ ] Handle GitHub API rate limiting gracefully
- [ ] Fix memory leaks in long-running processes

---

## Current Priority
**FOCUS: Complete magic link authentication**

Next steps:
1. Implement `/auth/email` request endpoint
2. Implement `/auth/email/callback` verify endpoint
3. Create UI pages
4. Write tests
5. Create PR (DO NOT MERGE)
