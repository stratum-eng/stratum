# Security Policy

Stratum hosts source code and handles authentication tokens, agent credentials, and secret
scanning. We take security seriously and appreciate responsible disclosure.

## Supported versions

Stratum is pre-1.0 and under active development. Security fixes are applied to the `main` branch
and the deployed instances. There is no long-term-support branch yet.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| older commits | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or
discussions.**

Instead, report privately through **GitHub Security Advisories** —
[open a private advisory](https://github.com/stratum-eng/stratum/security/advisories/new). This keeps
the report confidential and lets us collaborate on a fix before disclosure.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected endpoint/component, request samples).
- Any suggested remediation, if you have one.

## What to expect

- **Acknowledgement** within 3 business days.
- An assessment and, where valid, a remediation plan and timeline.
- Credit in the release notes once a fix ships, unless you prefer to remain anonymous.

## Scope

In scope: the Worker (`src/`), the `@stratum/cli` and `@stratum/agent` packages, authentication and
token handling, the evaluation engine, and the merge/Git pipeline.

Out of scope: vulnerabilities in third-party dependencies (report those upstream), denial-of-service
via resource exhaustion, and issues requiring physical access or a compromised Cloudflare account.

## Safe-harbor

We will not pursue legal action against researchers who act in good faith, avoid privacy violations
and service disruption, and give us reasonable time to remediate before public disclosure.
