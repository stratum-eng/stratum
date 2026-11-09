import type { FC } from "hono/jsx";
import { Layout } from "../layout";

export interface InstallationView {
  installationId: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  /** Who it is linked to, as the viewer may see it, or undefined when unlinked. */
  linkedTo?: string;
  /**
   * The viewer may start linking it. Starting is not succeeding: every link is
   * confirmed against the viewer's current access on GitHub.
   */
  canLink: boolean;
  /** The viewer may remove the current link. */
  canUnlink: boolean;
}

export interface LinkTarget {
  /** Form value: "" for the viewer's personal account, else an org slug. */
  value: string;
  label: string;
}

/** Fixed outcome messages, selected by code — the query string never supplies text. */
export const SETUP_NOTICES = {
  linked:
    "Installation linked. Projects owned by that account now use the app on its repositories.",
  unlinked:
    "Installation unlinked. Projects no longer use the app on its repositories, unless an operator binding covers them.",
  not_found: "That installation is not one you can manage here.",
  not_authorized:
    "GitHub says you do not manage that installation's account right now. Linking takes an owner of the GitHub organization the app is installed on, or the owner of the personal account.",
  bad_target: "Pick your personal account or an organization you administer.",
  linked_elsewhere:
    "This installation is already linked to an account you don't manage. Its owner (or an admin of that organization) must unlink it first.",
  bound_token: "This token is limited to one project or organization and cannot do that.",
  second_factor_required:
    "That organization requires a second factor. Add a passkey in Settings → Security, or sign in again with the one you have.",
  ip_not_allowed:
    "That organization only allows access from its configured networks. Connect from an allowed network, or ask an org admin to update its IP allowlist.",
  access_checked: "Checked with GitHub. The installations you can link right now are listed below.",
  state_invalid:
    "That GitHub authorization has expired or was already used. Nothing was changed — start again from this page.",
  authorization_denied: "GitHub authorization was cancelled. Nothing was changed.",
  github_unavailable:
    "GitHub could not confirm your access just now. Nothing was changed — try again in a moment.",
  github_account_required:
    "Linking needs a GitHub account connected to your Stratum account. Sign in with GitHub first.",
  github_account_mismatch:
    "You authorized as a different GitHub account than the one connected to your Stratum account. Switch accounts on GitHub and try again.",
  not_configured:
    "Linking is not configured on this deployment. An operator must set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET to the GitHub App's own client ID and secret.",
  browser_required:
    "Linking is confirmed with GitHub in a browser. Sign in to the web UI and link from /github/app/setup.",
  error: "Something went wrong. Nothing was changed — try again.",
} as const;

export type SetupNotice = keyof typeof SETUP_NOTICES;

interface Props {
  user: { id: string; email: string; username: string } | null;
  hasGitHubIdentity: boolean;
  /** The GitHub App's OAuth credentials are set, so links can be confirmed with GitHub. */
  linkingConfigured: boolean;
  installations: InstallationView[];
  linkTargets: LinkTarget[];
  /** An installation_id GitHub sent back that isn't recorded yet (webhook in flight). */
  pendingInstallationId?: number;
  /**
   * An installation_id GitHub sent back that is recorded but not yet shown to
   * be the viewer's. Offered by number alone: naming its account here would let
   * anyone learn which account an id belongs to by typing it into the URL.
   */
  unconfirmedInstallationId?: number;
  notice?: SetupNotice;
  /** Where "Sign in with GitHub" should come back to. */
  returnPath: string;
}

const LinkForm: FC<{ installationId: number; linkTargets: LinkTarget[] }> = ({
  installationId,
  linkTargets,
}) => (
  <form method="post" action={`/api/github/installations/${installationId}/link`}>
    <select name="org" aria-label="Stratum account">
      {linkTargets.map((target) => (
        <option key={target.value} value={target.value}>
          {target.label}
        </option>
      ))}
    </select>{" "}
    <button type="submit" class="btn btn-small btn-primary">
      Link
    </button>
  </form>
);

export const GitHubAppSetupPage: FC<Props> = ({
  user,
  hasGitHubIdentity,
  linkingConfigured,
  installations,
  linkTargets,
  pendingInstallationId,
  unconfirmedInstallationId,
  notice,
  returnPath,
}) => (
  <Layout
    title="GitHub App"
    user={user}
    {...(pendingInstallationId !== undefined ? { refreshSeconds: 5 } : {})}
  >
    <div class="page-header">
      <h1>GitHub App installations</h1>
    </div>

    {notice !== undefined && (
      <div class="card">
        <p>{SETUP_NOTICES[notice]}</p>
      </div>
    )}

    <div class="card">
      <p class="settings-help">
        Linking an installation lets projects owned by the linked Stratum account push branches,
        open pull requests, and report evaluations on that installation's repositories as the GitHub
        App. Other accounts' projects never use it, even if they point at the same repositories.
      </p>
      <p class="settings-help">
        Linking is confirmed with GitHub each time: you are sent to GitHub, and the link is made
        only if GitHub says you manage the account the app is installed on right now — an owner of
        the organization, or the personal account itself. Who originally installed the app does not
        matter.
      </p>
      {!linkingConfigured && (
        <p class="settings-help">
          <strong>Linking is not configured on this deployment.</strong> An operator must set{" "}
          <code>GITHUB_APP_CLIENT_ID</code> and <code>GITHUB_APP_CLIENT_SECRET</code> to the GitHub
          App's own client ID and secret. Existing links keep working and can still be removed.
        </p>
      )}
      {!hasGitHubIdentity && (
        <p class="settings-help">
          Your Stratum account has no GitHub account connected, so it cannot be matched to the
          account you authorize with.{" "}
          <a href={`/auth/github?next=${encodeURIComponent(returnPath)}`}>Sign in with GitHub</a>{" "}
          using the same verified email to connect it.
        </p>
      )}
      {linkingConfigured && hasGitHubIdentity && (
        <form method="post" action="/github/app/authorize">
          <button type="submit" class="btn btn-small">
            Find installations I can link
          </button>
        </form>
      )}
    </div>

    {pendingInstallationId !== undefined && (
      <div class="card">
        <p>
          Waiting for GitHub to confirm installation {pendingInstallationId}. This page refreshes by
          itself.
        </p>
      </div>
    )}

    {unconfirmedInstallationId !== undefined &&
      linkingConfigured &&
      hasGitHubIdentity &&
      linkTargets.length > 0 && (
        <div class="card">
          <p>Link installation {unconfirmedInstallationId} to:</p>
          <LinkForm installationId={unconfirmedInstallationId} linkTargets={linkTargets} />
          <p class="settings-help">GitHub will be asked to confirm that you manage it.</p>
        </div>
      )}

    {installations.length === 0 ? (
      <div class="empty-state">
        <p>No installations you can manage.</p>
      </div>
    ) : (
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>GitHub account</th>
              <th>Linked to</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {installations.map((inst) => (
              <tr key={String(inst.installationId)}>
                <td>
                  {inst.accountLogin} <span class="settings-help">({inst.accountType})</span>
                  {inst.suspended && <span class="settings-help"> — suspended</span>}
                </td>
                <td>{inst.linkedTo ?? "Not linked"}</td>
                <td>
                  {inst.canLink && linkTargets.length > 0 && (
                    <LinkForm installationId={inst.installationId} linkTargets={linkTargets} />
                  )}
                  {inst.canUnlink && inst.linkedTo !== undefined && (
                    <form
                      method="post"
                      action={`/api/github/installations/${inst.installationId}/unlink`}
                    >
                      <button type="submit" class="btn btn-small btn-danger">
                        Unlink
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Layout>
);
