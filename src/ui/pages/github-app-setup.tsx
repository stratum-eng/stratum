import type { FC } from "hono/jsx";
import { Layout } from "../layout";

export interface InstallationView {
  installationId: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  /** Who it is linked to, as the viewer may see it, or undefined when unlinked. */
  linkedTo?: string;
  /** The viewer can prove control on GitHub, so may (re)link it. */
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
    "Only the GitHub user who installed the app (or, for a personal account, its owner) can link it.",
  bad_target: "Pick your personal account or an organization you administer.",
  linked_elsewhere:
    "This installation is already linked to an account you don't manage. Its owner (or an admin of that organization) must unlink it first.",
  bound_token: "This token is limited to one project or organization and cannot do that.",
  second_factor_required:
    "That organization requires a second factor. Add a passkey in Settings → Security, or sign in again with the one you have.",
  ip_not_allowed:
    "That organization only allows access from its configured networks. Connect from an allowed network, or ask an org admin to update its IP allowlist.",
  error: "Something went wrong. Nothing was changed — try again.",
} as const;

export type SetupNotice = keyof typeof SETUP_NOTICES;

interface Props {
  user: { id: string; email: string; username: string } | null;
  hasGitHubIdentity: boolean;
  installations: InstallationView[];
  linkTargets: LinkTarget[];
  /** An installation_id GitHub sent back that isn't recorded yet (webhook in flight). */
  pendingInstallationId?: number;
  notice?: SetupNotice;
  /** Where "Sign in with GitHub" should come back to. */
  returnPath: string;
}

export const GitHubAppSetupPage: FC<Props> = ({
  user,
  hasGitHubIdentity,
  installations,
  linkTargets,
  pendingInstallationId,
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
      {!hasGitHubIdentity && (
        <p class="settings-help">
          Your Stratum account has no GitHub account linked, so Stratum cannot tell which
          installations are yours.{" "}
          <a href={`/auth/github?next=${encodeURIComponent(returnPath)}`}>Sign in with GitHub</a>{" "}
          using the same verified email to link it.
        </p>
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
                    <form
                      method="post"
                      action={`/api/github/installations/${inst.installationId}/link`}
                    >
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
