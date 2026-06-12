# @stratum/cli

CLI for Stratum — code hosting for the AI engineering era. Wraps the Stratum REST API.

## Setup

```bash
stratum login --host https://your-stratum-instance --key stratum_user_…
# or set STRATUM_HOST and STRATUM_API_KEY (these override the config file)
```

## Commands

```bash
stratum init <name> [--org <slug>] [--public]   # create a project
stratum projects                                # list your projects
stratum activity <ns/slug>                      # recent project activity

stratum workspace create <ns/slug> [--name x]   # fork a workspace
stratum workspace list <ns/slug>
stratum workspace delete <ns/slug> <name>

stratum commit --project <ns/slug> --workspace <name> -m "msg"
                                                # commit staged git files

stratum change create --project <ns/slug> --workspace <name>
stratum change list <ns/slug> [--status open]
stratum change show <id>                        # eval evidence + costs
stratum change review <id> --verdict approve|request_changes [--comment …]
stratum change merge <id> [--force] [--squash]
stratum change reject <id>

stratum issue create <ns/slug> --title "…" [--body …] [--change chg_…]
stratum issue list <ns/slug> [--status closed]
stratum issue close <ns/slug> <number>

stratum status                                  # who am I
```

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsc → dist/
```
