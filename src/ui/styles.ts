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
  max-width: 800px;
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
`;
