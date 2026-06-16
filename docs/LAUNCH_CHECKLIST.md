# Closed-Beta Launch Checklist

Tracks what remains to take the closed-beta referral program live. Spans two
repos: **stratum** (this repo, the app) and **stratum-landing** (marketing site +
referral service).

## Already done
- `REFERRAL_SERVICE_SECRET` set on both the `stratum` and `stratum-landing` Workers.
- `stratum-referral` D1 database created and schema applied.
- Landing Worker deployed; referral endpoints (`validate`/`admit`/`seed`/`codes`)
  verified working at the `*.workers.dev` URL.

## A. Merge the PRs
- [ ] Merge **#93** (config restructure: generic self-host default + `[env.production]`,
      `app.usestratum.dev`). Deploys production via `--env=production`.
- [ ] Merge **#92** (closed-beta gate). No longer touches `wrangler.toml`, so it
      merges cleanly in any order relative to #93.

## B. Core app → `app.usestratum.dev` (after #93)
- [ ] `npm run deploy:staging`, verify, then run the **Deploy Production** workflow
      (or `npm run deploy:production`). The custom domain + TLS cert provision on deploy.
- [ ] Register OAuth callback URLs (sign-in breaks without them):
  - GitHub OAuth app → `https://app.usestratum.dev/auth/github/callback`
    (+ `https://staging.app.usestratum.dev/auth/github/callback`)
  - Google OAuth client → `https://app.usestratum.dev/auth/google/callback` (+ staging)
- [ ] Verify `https://app.usestratum.dev/health` responds.

## C. Landing apex `usestratum.dev` → Worker (Cloudflare dashboard)
- [ ] Remove `usestratum.dev` (and `www`) from the **Pages project** custom domains.
- [ ] Add `usestratum.dev` as a custom domain on the **`stratum-landing` Worker**.
- [ ] Verify it serves the Worker, not Pages:
      `curl -X POST https://usestratum.dev/api/referral/validate -d '{"code":"X"}'`
      → `200` JSON (a `405` means it's still on Pages).
- [ ] `wrangler secret put POSTHOG_API_KEY` on the landing Worker.
- [ ] Replace `POSTHOG_API_KEY_PLACEHOLDER` in `stratum-landing/public/index.html`.
- [ ] Settle the CD path: the landing GitHub Actions workflow now deploys on push to
      `main` (Cloudflare's Workers Builds only *builds*, it didn't deploy on merge).
      Keep Workers Builds as build-only, or disconnect it, to avoid double-deploys.

## D. Turn the beta on (only after B **and** C)
- [ ] In `wrangler.toml` `[env.production.vars]`, uncomment `BETA_GATE = "1"` and
      `REFERRAL_SERVICE_URL = "https://usestratum.dev"`, then deploy production.
      ⚠️ Not before the apex cutover — it would hit old Pages (405) and block signups.
- [ ] Mint seed codes:
      `curl -X POST https://usestratum.dev/api/referral/seed -H "Authorization: Bearer <secret>" -d '{"count":25}'`
- [ ] End-to-end test: redeem a seed code → account created → 5 codes emailed.

## E. Housekeeping (optional)
- [ ] Rotate `REFERRAL_SERVICE_SECRET` on both Workers (it was generated in a chat session).
- [ ] Delete the old Pages project once the apex cutover is confirmed.
- [ ] (Open-core) abstract referral specifics out of core's auth path behind a
      generic signup-policy hook, so core carries no go-to-market vocabulary.
