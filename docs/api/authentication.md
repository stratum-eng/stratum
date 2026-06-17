# Authentication

Stratum supports multiple authentication methods.

## Methods

### Session Cookies
For web UI users via email magic links or GitHub OAuth.

### API Tokens
For programmatic access:
- User tokens: `stratum_user_xxxxx`
- Agent tokens: `stratum_agent_xxxxx`

## Usage

```bash
curl -H "Authorization: Bearer stratum_user_xxxxx" \
  https://your-instance.workers.dev/api/projects
```

## Dev Login

For local development:
```bash
curl http://localhost:8787/dev-login
```
