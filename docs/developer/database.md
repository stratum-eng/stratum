# Database Schema

## Tables

### users
- id, email, username, token_hash

### agents
- id, name, owner_id, token_hash

### changes
- id, project, workspace, status, eval_score

### eval_runs
- id, change_id, evaluator_type, score, passed

### import_jobs
- id, namespace, slug, status, progress
