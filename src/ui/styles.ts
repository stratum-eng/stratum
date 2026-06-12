export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0a0a0a;
  color: #f0f0f0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  line-height: 1.6;
}

a { color: #7ca9f7; text-decoration: none; }
a:hover { text-decoration: underline; }

.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid #1e1e1e;
  background: #0d0d0d;
}

.nav-brand {
  font-size: 1.1rem;
  font-weight: 700;
  color: #f0f0f0;
  letter-spacing: 0.05em;
}
.nav-brand:hover { text-decoration: none; color: #7ca9f7; }

.nav-links { display: flex; gap: 1.25rem; }
.nav-links a { color: #999; font-size: 0.9rem; }
.nav-links a:hover { color: #f0f0f0; text-decoration: none; }

.nav-auth {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.nav-user {
  color: #888;
  font-size: 0.85rem;
}

.nav-auth-link {
  color: #7ca9f7;
  font-size: 0.9rem;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  transition: background 0.15s;
}

.nav-auth-link:hover {
  background: #1a3a6e;
  text-decoration: none;
}

.main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.page-header h1 { font-size: 1.4rem; font-weight: 700; }

.card {
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 6px;
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}

.card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #ccc; }

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
}

.card-link {
  display: block;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.15s;
}
.card-link:hover { border-color: #444; text-decoration: none; }
.card-title { font-weight: 600; color: #f0f0f0; margin-bottom: 0.25rem; }
.card-meta { font-size: 0.8rem; color: #666; }

.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e1e1e; color: #888; font-weight: 500; font-size: 0.85rem; }
.table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #111; vertical-align: middle; }
.table tr:last-child td { border-bottom: none; }
.table a { color: #7ca9f7; }

.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.badge-open     { background: #1a3a6e; color: #7ca9f7; }
.badge-approved { background: #1a3d2b; color: #4ade80; }
.badge-merged   { background: #2d1a5e; color: #c084fc; }
.badge-rejected { background: #3d1a1a; color: #f87171; }
.badge-public   { background: #1a3a1e; color: #4ade80; margin-left: 0.5rem; font-size: 0.65rem; }

/* README styling */
.readme-card {
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
}

.readme-content pre {
  margin: 0;
  padding: 1rem;
  background: transparent;
  color: #ccc;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.btn {
  display: inline-block;
  padding: 0.4rem 0.85rem;
  border: 1px solid #333;
  border-radius: 4px;
  background: #1a1a1a;
  color: #ccc;
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  text-decoration: none;
  line-height: 1.4;
}
.btn:hover { background: #222; color: #f0f0f0; text-decoration: none; }
.btn-primary { background: #1a3a6e; border-color: #2a5aae; color: #7ca9f7; }
.btn-primary:hover { background: #1f4a8e; color: #a8c8f8; }
.btn-danger  { background: #3d1a1a; border-color: #6e2a2a; color: #f87171; }
.btn-danger:hover  { background: #4d2020; color: #fca5a5; }

.empty-state { padding: 2rem 0; color: #555; text-align: center; }

.file-list { list-style: none; }
.file-item { padding: 0.3rem 0; border-bottom: 1px solid #161616; font-size: 0.85rem; color: #ccc; }
.file-item:last-child { border-bottom: none; }

.detail-list { display: grid; grid-template-columns: 140px 1fr; gap: 0.4rem 1rem; }
.detail-list dt { color: #666; font-size: 0.85rem; }
.detail-list dd { color: #ccc; }

.action-row { display: flex; gap: 0.75rem; margin-top: 1rem; }

.issue-list { margin-top: 0.35rem; padding-left: 1rem; color: #fca5a5; }

.mono { font-family: 'JetBrains Mono', monospace; }

/* Import Progress Styles */
.import-progress-card {
  border-left: 4px solid #7ca9f7;
}

.import-progress-card[data-import-status="completed"] {
  border-left-color: #4ade80;
}

.import-progress-card[data-import-status="failed"] {
  border-left-color: #f87171;
}

.import-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.import-header h2 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.1rem;
}

.spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid #333;
  border-top-color: #7ca9f7;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.icon-success { color: #4ade80; }
.icon-error { color: #f87171; }
.icon-cancelled { color: #888; }

.badge {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: #1a1a1a;
  color: #888;
}

.badge-queued { background: #1a1a1a; color: #888; }
.badge-cloning { background: #1a3a6e; color: #7ca9f7; }
.badge-processing { background: #3e3a1a; color: #f7c97c; }
.badge-completed { background: #1a3e1a; color: #4ade80; }
.badge-failed { background: #3d1a1a; color: #f87171; }
.badge-cancelled { background: #2a2a2a; color: #999; }

.import-source {
  margin-bottom: 1rem;
  padding: 0.75rem;
  background: #111;
  border-radius: 6px;
  font-size: 0.85rem;
}

.import-source p {
  margin: 0.25rem 0;
  color: #888;
}

.progress-section {
  margin: 1rem 0;
}

.progress-bar {
  height: 8px;
  background: #1a1a1a;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #7ca9f7, #a8c8f8);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 0.85rem;
  color: #666;
}

.current-file {
  color: #888;
  margin-left: 0.5rem;
}

.errors-section {
  margin-top: 1rem;
  padding: 0.75rem;
  background: #1a0a0a;
  border: 1px solid #3d1a1a;
  border-radius: 6px;
}

.errors-section h3 {
  color: #f87171;
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
}

.error-list {
  list-style: none;
  font-size: 0.8rem;
}

.error-item {
  padding: 0.25rem 0;
  color: #fca5a5;
  border-bottom: 1px solid #2d1a1a;
}

.error-item:last-child {
  border-bottom: none;
}

.more-errors {
  font-size: 0.8rem;
  color: #888;
  margin-top: 0.5rem;
}

.logs-section {
  margin-top: 1rem;
}

.logs-section details {
  font-size: 0.85rem;
}

.logs-section summary {
  cursor: pointer;
  color: #888;
  padding: 0.5rem 0;
}

.log-list {
  list-style: none;
  padding: 0.5rem;
  background: #111;
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.log-item {
  display: flex;
  gap: 0.5rem;
  padding: 0.2rem 0;
  font-size: 0.8rem;
  border-bottom: 1px solid #1a1a1a;
}

.log-item:last-child {
  border-bottom: none;
}

.log-time {
  color: #555;
  flex-shrink: 0;
}

.log-info .log-message { color: #888; }
.log-warn .log-message { color: #f7c97c; }
.log-error .log-message { color: #f87171; }

.actions-section {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #1e1e1e;
}

.btn-secondary { background: #1e1e1e; border-color: #333; color: #ccc; }
.btn-secondary:hover { background: #2a2a2a; color: #f0f0f0; }

.error-alert {
  margin: 1rem 0;
  padding: 1rem;
  background: #1a0a0a;
  border: 1px solid #5d2a2a;
  border-radius: 6px;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.error-header h3 {
  font-size: 0.95rem;
  color: #f87171;
  margin: 0;
}

.error-icon { font-size: 1rem; }

.error-description {
  font-size: 0.85rem;
  color: #fca5a5;
  margin: 0 0 0.75rem;
}

.troubleshooting-section { margin-top: 0.75rem; }

.troubleshooting-section h4 {
  font-size: 0.85rem;
  color: #f7c97c;
  margin: 0 0 0.4rem;
}

.troubleshooting-tips {
  padding-left: 1.25rem;
  margin: 0;
}

.troubleshooting-tips li {
  font-size: 0.82rem;
  color: #aaa;
  padding: 0.15rem 0;
}

.error-action { margin-top: 0.75rem; }

.failed-actions { display: flex; gap: 0.5rem; }

.retry-form { display: inline; }

.technical-errors summary { color: #888; cursor: pointer; padding: 0.5rem 0; font-size: 0.85rem; }

/* File Tree */
.file-tree { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; }
.file-tree-dir { border: none; }
.file-tree-dir > summary {
  cursor: pointer;
  list-style: none;
  padding: 0.25rem 0;
  color: #aaa;
  user-select: none;
}
.file-tree-dir > summary::before { content: "▶  "; font-size: 0.7rem; }
.file-tree-dir[open] > summary::before { content: "▼  "; font-size: 0.7rem; }
.file-tree-dir > summary::-webkit-details-marker { display: none; }
.file-tree-dir > summary::marker { content: ""; }
.file-tree-children { padding-left: 1.25rem; }
.file-tree-file { padding: 0.2rem 0; }
.file-tree-file a { color: #ccc; text-decoration: none; display: block; }
.file-tree-file a:hover { color: #f0f0f0; text-decoration: underline; }
.file-tree-notice { font-size: 0.8rem; color: #555; margin-top: 0.75rem; font-style: italic; }
.file-tree-controls { margin-bottom: 0.5rem; }
.file-tree-toggle-btn { background: none; border: none; color: #666; font-size: 0.75rem; cursor: pointer; padding: 0; font-family: inherit; }
.file-tree-toggle-btn:hover { color: #aaa; }

/* Activity Feed */
.activity-list { list-style: none; padding: 0; margin: 0; }
.activity-item {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid #222;
  font-size: 0.9rem;
}
.activity-actor {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  flex-shrink: 0;
}
.activity-actor-user { background: #1e3a5f; color: #7cb7ff; }
.activity-actor-agent { background: #3b2a5f; color: #c4a7ff; }
.activity-actor-system { background: #2a2a2a; color: #888; }
.activity-description { flex: 1; color: #ccc; }
.activity-description a { color: #7cb7ff; text-decoration: none; }
.activity-description a:hover { text-decoration: underline; }
.activity-time { color: #555; font-size: 0.8rem; flex-shrink: 0; }

/* Webhooks */
.webhook-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 480px; }
.webhook-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #aaa; }
.webhook-form input {
  background: #111; border: 1px solid #333; color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}
.webhook-help { font-size: 0.8rem; color: #666; }
.webhook-card { margin-top: 1rem; }
.webhook-card-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.webhook-url { font-size: 0.85rem; color: #7cb7ff; margin-right: 0.5rem; word-break: break-all; }
.webhook-actions { display: flex; gap: 0.5rem; }
.webhook-meta { font-size: 0.8rem; color: #777; margin: 0.5rem 0 0; word-break: break-all; }
.webhook-deliveries { margin-top: 0.75rem; font-size: 0.85rem; }
.webhook-deliveries summary { cursor: pointer; color: #888; }
.webhook-deliveries ul { list-style: none; padding: 0.5rem 0 0; margin: 0; }
.webhook-delivery { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.25rem 0; flex-wrap: wrap; }
.webhook-delivery-type { font-family: 'JetBrains Mono', monospace; color: #ccc; }
.webhook-delivery-meta { color: #777; }
.webhook-delivery-time { color: #555; margin-left: auto; }
.btn-small { font-size: 0.75rem; padding: 0.25rem 0.6rem; }
.btn-danger { color: #f87171; border-color: #5f1e1e; }

/* Issues */
.page-header-actions { display: flex; gap: 0.5rem; }
.issues-filter { display: flex; gap: 1rem; margin-bottom: 1rem; font-size: 0.9rem; }
.issues-filter a { color: #777; text-decoration: none; }
.issues-filter a:hover { color: #ccc; }
.issues-filter-active { color: #f0f0f0 !important; font-weight: 600; }
.issues-list { list-style: none; padding: 0; margin: 0; }
.issues-item {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid #222;
  font-size: 0.9rem;
  flex-wrap: wrap;
}
.issues-title { color: #e8e8e8; text-decoration: none; flex: 1; min-width: 200px; }
.issues-title:hover { color: #7cb7ff; }
.issues-linked-change { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: #c4a7ff; }
.issues-meta { color: #555; font-size: 0.8rem; }
.issue-status-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.issue-body { margin-top: 1rem; }
.issue-body-text { white-space: pre-wrap; word-break: break-word; font-family: inherit; margin: 0; }
.issue-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 560px; }
.issue-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #aaa; }
.issue-form input, .issue-form textarea {
  background: #111; border: 1px solid #333; color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}

/* Syntax highlighting (server-side lexer) */
.tok-comment { color: #6a737d; font-style: italic; }
.tok-string { color: #9ecbff; }
.tok-number { color: #f8c555; }
.tok-keyword { color: #f97583; }

/* Diff viewer */
.diff-view { display: flex; flex-direction: column; gap: 0.75rem; }
.diff-empty { color: #666; font-size: 0.85rem; }
.diff-file { border: 1px solid #2a2a2a; border-radius: 6px; overflow: hidden; }
.diff-file-header {
  display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
  padding: 0.5rem 0.75rem; background: #181818; cursor: pointer;
  font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
}
.diff-file-path { color: #e8e8e8; word-break: break-all; }
.diff-file-stats { flex-shrink: 0; }
.diff-stat-add { color: #4ade80; }
.diff-stat-del { color: #f87171; }
.diff-file-body {
  margin: 0; padding: 0.5rem 0; overflow-x: auto;
  font-size: 0.8rem; line-height: 1.5; background: #0d0d0d;
}
.diff-line { display: block; padding: 0 0.75rem; white-space: pre; }
.diff-add { background: rgba(74, 222, 128, 0.12); color: #b9f0cd; }
.diff-del { background: rgba(248, 113, 113, 0.12); color: #f5c2c2; }
.diff-hunk { color: #7cb7ff; background: #14181f; }

/* Settings */
.settings-help { font-size: 0.85rem; color: #888; }
.settings-token-reveal { border: 1px solid #2d4f2d; background: #101a10; }
.settings-token {
  display: block; padding: 0.6rem 0.75rem; background: #0d0d0d;
  border: 1px solid #333; border-radius: 4px; word-break: break-all;
  font-size: 0.85rem; color: #9ecbff;
}
.settings-agent-form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 420px; margin-top: 1rem; }
.settings-agent-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: #aaa; }
.settings-agent-form input {
  background: #111; border: 1px solid #333; color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}

/* Costs */
.cost-list { list-style: none; padding: 0; margin: 0; font-size: 0.9rem; color: #ccc; }
.cost-list li { padding: 0.2rem 0; }

/* Change reviews and comments */
.review-empty { color: #666; font-size: 0.85rem; }
.review-list, .comment-list { list-style: none; padding: 0; margin: 0; }
.review-item {
  display: flex; align-items: baseline; gap: 0.75rem;
  padding: 0.4rem 0; border-bottom: 1px solid #222; font-size: 0.85rem; flex-wrap: wrap;
}
.review-reviewer { color: #aaa; font-size: 0.8rem; }
.review-comment { color: #ccc; flex: 1; }
.review-time { color: #555; font-size: 0.75rem; margin-left: auto; }
.review-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.comment-item { padding: 0.6rem 0; border-bottom: 1px solid #222; }
.comment-meta { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.8rem; color: #888; }
.comment-body {
  white-space: pre-wrap; word-break: break-word; font-family: inherit;
  margin: 0.35rem 0 0; color: #ddd; font-size: 0.9rem;
}
.comment-form { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.75rem; max-width: 560px; }
.comment-form textarea {
  background: #111; border: 1px solid #333; color: #eee;
  padding: 0.5rem; border-radius: 4px; font-family: inherit;
}

/* File Viewer */
.file-viewer-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem;
  margin-bottom: 0;
  color: #888;
}
.file-viewer-breadcrumb a { color: #7ca9f7; text-decoration: none; }
.file-viewer-breadcrumb a:hover { text-decoration: underline; }
.file-viewer-breadcrumb .sep { color: #444; }
.file-viewer-breadcrumb-current { color: #f0f0f0; }
.file-viewer-content { padding: 0; overflow: hidden; }
.file-viewer-content pre {
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
  white-space: pre;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: #d4d4d4;
  line-height: 1.6;
  background: #0d0d0d;
}
.file-viewer-message { padding: 1.5rem; color: #666; font-style: italic; font-size: 0.85rem; margin: 0; }

/* Repo page two-column layout */
.repo-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 1rem;
  align-items: start;
}

.repo-sidebar { position: sticky; top: 1rem; }
.repo-main { min-width: 0; }

@media (max-width: 700px) {
  .repo-layout { grid-template-columns: 1fr; }
  .repo-sidebar { position: static; }
}

/* README rendered markdown */
.readme-card h2 { margin-bottom: 1rem; }

.readme-content { font-size: 0.875rem; line-height: 1.7; color: #ccc; }
.readme-content h1 { font-size: 1.3rem; color: #f0f0f0; margin: 1.25rem 0 0.5rem; border-bottom: 1px solid #222; padding-bottom: 0.3rem; }
.readme-content h2 { font-size: 1.1rem; color: #e0e0e0; margin: 1.1rem 0 0.4rem; border-bottom: 1px solid #1a1a1a; padding-bottom: 0.25rem; }
.readme-content h3 { font-size: 0.95rem; color: #d0d0d0; margin: 0.9rem 0 0.3rem; }
.readme-content h4, .readme-content h5, .readme-content h6 { color: #bbb; margin: 0.75rem 0 0.25rem; }
.readme-content p { margin: 0.5rem 0; }
.readme-content a { color: #7ca9f7; }
.readme-content a:hover { text-decoration: underline; }
.readme-content code { font-family: 'JetBrains Mono', monospace; font-size: 0.8em; background: #1a1a1a; padding: 0.1em 0.35em; border-radius: 3px; color: #e0e0e0; }
.readme-content pre { background: #0d0d0d; border: 1px solid #222; border-radius: 6px; padding: 1rem; overflow-x: auto; margin: 0.75rem 0; }
.readme-content pre code { background: none; padding: 0; font-size: 0.8rem; color: #d4d4d4; }
.readme-content blockquote { border-left: 3px solid #333; margin: 0.75rem 0; padding: 0.25rem 0 0.25rem 1rem; color: #888; }
.readme-content ul, .readme-content ol { padding-left: 1.5rem; margin: 0.5rem 0; }
.readme-content li { margin: 0.2rem 0; }
.readme-content table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.75rem 0; }
.readme-content th { background: #1a1a1a; color: #aaa; font-weight: 600; text-align: left; padding: 0.4rem 0.6rem; border: 1px solid #2a2a2a; }
.readme-content td { padding: 0.35rem 0.6rem; border: 1px solid #1e1e1e; color: #bbb; }
.readme-content tr:nth-child(even) td { background: #0d0d0d; }
.readme-content img { max-width: 100%; border-radius: 4px; }
.readme-content hr { border: none; border-top: 1px solid #222; margin: 1rem 0; }
.readme-content details { margin: 0.5rem 0; }
.readme-content summary { cursor: pointer; color: #888; }

/* Commit table */
.commit-table { table-layout: fixed; width: 100%; }
.commit-sha { width: 72px; font-size: 0.8rem; color: #7ca9f7; }
.commit-message { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0; }
.commit-author { width: 160px; font-size: 0.82rem; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-date { width: 96px; font-size: 0.82rem; color: #666; text-align: right; }
`;
