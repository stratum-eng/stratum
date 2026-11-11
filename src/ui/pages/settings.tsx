import type { FC } from "hono/jsx";
import type { InviteCodesResult } from "../../beta/gate";
import type { UsageBannerNotice } from "../../billing/usage-banner";
import { UNRESOLVED_BINDING_LABEL } from "../../services/token-binding";
import {
  type ApiTokenSummary,
  MAX_ACTIVE_TOKENS_PER_USER,
  MAX_TOKEN_EXPIRY_DAYS,
  MIN_TOKEN_EXPIRY_DAYS,
  isExpired,
} from "../../storage/api-tokens";
import type { OAuthGrantSummary } from "../../storage/oauth";
import type { ApiTokenScope } from "../../types";
import { MAX_DISPLAY_NAME_LENGTH } from "../../utils/display-name";
import { FieldError, fieldAttrs } from "../components/field-error";
import { formatDate } from "../format";
import { Layout } from "../layout";
import { InviteCodesCard } from "./invite-codes";

interface AgentSummary {
  id: string;
  name: string;
  model?: string;
  createdAt: string;
}

/** The signed-in account as the settings page shows it. */
export interface SettingsUser {
  id: string;
  email: string;
  username: string;
  displayName?: string | undefined;
  createdAt: string;
  githubUsername?: string | undefined;
}

/**
 * A credential rendered exactly once, in the POST response that created it.
 * A union rather than a bag of optional fields so that, for instance, a scoped
 * token can never be displayed without the name its owner gave it.
 */
export type FreshCredential =
  | { kind: "api-key"; value: string }
  | { kind: "agent"; value: string; agentName?: string }
  | { kind: "scoped-token"; value: string; tokenName: string };

/** A one-off message about the action that just ran. */
export interface SettingsNotice {
  kind: "success" | "error";
  message: string;
}

/** The settings fields whose refusal the server reports inline, under the field. */
export type SettingsField = "displayName" | "username" | "tokenName" | "tokenExpiry" | "agentName";

/**
 * A submission refused because of what was typed into one field. Rendered
 * under that field (with `aria-invalid` on it), and summarized at the top of
 * the page with a link down to it — the re-rendered page opens at the top, and
 * the token and agent forms are a long scroll below.
 */
export interface SettingsFieldError {
  field: SettingsField;
  message: string;
}

/**
 * What the user had entered into a refused form, so it comes back as they
 * left it. The token form carries every field, not only the ones that can be
 * refused inline: a re-render that dropped the scope or the project/org
 * binding would turn "fix the name and resubmit" into minting a read-write or
 * account-wide token nobody asked for (#398).
 */
export type SettingsFormValues = Partial<
  Record<SettingsField | "tokenScope" | "tokenProject" | "tokenOrg" | "agentModel", string>
>;

/** Each field's control id: the error summary links to it. */
const FIELD_IDS: Record<SettingsField, string> = {
  displayName: "settings-display-name",
  username: "settings-username",
  tokenName: "settings-token-name",
  tokenExpiry: "settings-token-expiry",
  agentName: "settings-agent-name",
};

/** The message for `field`, when it is the one refused. */
function errorFor(fieldError: SettingsFieldError | undefined, field: SettingsField) {
  return fieldError?.field === field ? fieldError.message : undefined;
}

/** `fieldAttrs` for a settings control, keyed by field rather than by id. */
function settingsFieldAttrs(
  fieldError: SettingsFieldError | undefined,
  field: SettingsField,
  helpId?: string,
) {
  return fieldAttrs(FIELD_IDS[field], errorFor(fieldError, field), helpId);
}

/** The inline error under a settings control, when that control was refused. */
const SettingsFieldErrorText: FC<{
  fieldError?: SettingsFieldError | undefined;
  field: SettingsField;
}> = ({ fieldError, field }) => (
  <FieldError for={FIELD_IDS[field]} message={errorFor(fieldError, field)} />
);

/**
 * Whether the username form is offered. "blocked" means the account owns
 * projects (or did within the last claim window); "unavailable" means the
 * check itself failed, which withholds the form all the same but is the
 * reader's cue to retry rather than to go delete something.
 */
export type UsernameChange = "allowed" | "blocked" | "unavailable";

interface SettingsPageProps {
  user: SettingsUser;
  /**
   * True while the account owns no projects — the only time the username can
   * change, since it is the namespace every project is keyed under.
   */
  usernameChange: UsernameChange;
  /** Absent when no referral service is configured; the card is then not rendered. */
  invites?: InviteCodesResult;
  /** Origin for invite share links, e.g. https://referral.usestratum.dev. */
  shareBaseUrl?: string;
  agents: AgentSummary[];
  apiTokens: ApiTokenSummary[];
  /** What each bound token (#323) is limited to, keyed by token id. A token
   * absent from the map is account-wide. */
  tokenBindingLabels?: ReadonlyMap<string, string>;
  /** MCP clients the user has authorized over OAuth (#349). */
  oauthGrants: OAuthGrantSummary[];
  /** True when the listing could not be READ, as opposed to being empty.
   * "No applications connected" is a reassurance, and it must not be shown to
   * someone whose connection list we simply failed to load. */
  oauthGrantsUnavailable: boolean;
  freshToken?: FreshCredential;
  notice?: SettingsNotice;
  /** A refused form field, rendered inline; see `SettingsFieldError`. */
  fieldError?: SettingsFieldError | undefined;
  /** What a refused form held, to refill it; see `SettingsFormValues`. */
  formValues?: SettingsFormValues | undefined;
  /** Per-request CSP nonce for the copy-button scripts. */
  nonce?: string;
  /** True when the user has opted out of product analytics (#257). */
  telemetryOptOut: boolean;
  /** The 80% warning, when this account has one. See `Layout`. */
  usageNotice?: UsageBannerNotice | null;
  /** Absent when the deployment has not turned the feature on; the card is then not rendered. */
  githubConnection?: GitHubConnectionView;
}

/**
 * The person's GitHub connection, as the settings page shows it. `unknown`
 * when it could not be read: neither "connected" nor "not connected" may be
 * claimed then.
 */
export type GitHubConnectionView =
  | { state: "connected"; githubLogin: string; connectedAt: string }
  | { state: "not_connected"; canConnect: boolean }
  | { state: "unknown" };

const SCOPE_LABEL: Record<ApiTokenScope, string> = {
  read: "Read-only",
  read_write: "Read & write",
};

/** Same rule the signup forms apply, so the browser refuses what the server would. */
const USERNAME_PATTERN = "^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,38}$";
const USERNAME_RULES =
  "3-39 characters, lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen.";

const DOCS = "https://docs.usestratum.dev";

/** The page's sections, in order, for the jump links under the heading. */
const SECTIONS: ReadonlyArray<readonly [id: string, label: string]> = [
  ["account", "Account"],
  ["privacy", "Privacy"],
  ["tokens", "API tokens"],
  ["connections", "Connected apps"],
  ["github", "GitHub"],
  ["agents", "Agents"],
  ["danger", "Danger zone"],
];

/** Revoked beats expired: an explicitly revoked token stays revoked in the
 * listing even once its expiry has also passed. */
function tokenStatus(token: ApiTokenSummary, now: number): "Revoked" | "Expired" | "Active" {
  if (token.revokedAt !== undefined) return "Revoked";
  if (token.expiresAt !== undefined) {
    const expiresAt = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return "Expired";
  }
  return "Active";
}

/** Clipboard needs script; the value is read from the DOM, never re-serialized. */
const COPY_TOKEN_SCRIPT = `
(function () {
  var btn = document.getElementById('copy-fresh-token');
  var token = document.getElementById('fresh-token');
  if (!btn || !token) return;
  btn.addEventListener('click', function () {
    // Clipboard API can be missing (insecure context) or blocked by policy;
    // fall back to selecting the value so a manual Ctrl/Cmd+C still works.
    var fallback = function () {
      var range = document.createRange();
      range.selectNodeContents(token);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = 'Press Ctrl/Cmd+C';
      setTimeout(function () { btn.textContent = 'Copy'; }, 3000);
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fallback();
      return;
    }
    navigator.clipboard.writeText(token.textContent).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
    }, fallback);
  });
})();
`;

/**
 * One connected MCP client.
 *
 * `clientName` is self-asserted at registration by an anonymous caller, so it
 * is rendered as a plain string (JSX escapes it) and never as a link — and the
 * client_id is shown beside it, because that is the only part of the row the
 * user did not have to take on trust.
 */
/**
 * Who a connection acts as (#409, ADR 010). A grant from before agent binding,
 * or one where the user chose "Me", acts as the user, and the label says what
 * that costs: no agent provenance on its work.
 */
const GrantActsAs: FC<{ grant: OAuthGrantSummary }> = ({ grant }) => {
  if (grant.agent === undefined) return <>You (no agent provenance)</>;
  if (grant.agent.name === undefined) return <>Deleted agent (no longer works)</>;
  return <>Agent: {grant.agent.name}</>;
};

const OAuthGrantRow: FC<{ grant: OAuthGrantSummary }> = ({ grant }) => (
  <tr>
    <td>{grant.clientName}</td>
    <td>
      <code>{grant.clientId}</code>
    </td>
    <td>{grant.scope.includes("mcp:write") ? "Read & write" : "Read-only"}</td>
    <td>
      <GrantActsAs grant={grant} />
    </td>
    <td>{formatDate(grant.createdAt)}</td>
    <td>{grant.lastUsedAt === undefined ? "Never used" : formatDate(grant.lastUsedAt)}</td>
    <td>
      <form method="post" action={`/settings/connections/${grant.id}/revoke`}>
        <button type="submit" class="btn btn-small btn-danger">
          Disconnect
        </button>
      </form>
    </td>
  </tr>
);

/**
 * What a token can reach (#323). A bound token whose label could not be
 * resolved still says it is limited — showing it as "All projects" would
 * overstate what it can do in the direction that matters.
 */
function tokenAccessLabel(token: ApiTokenSummary, label: string | undefined): string {
  if (token.binding === undefined) return "All projects";
  if (label === UNRESOLVED_BINDING_LABEL) return `Limited (${UNRESOLVED_BINDING_LABEL})`;
  const target = label ?? (token.binding.kind === "project" ? "one project" : "one organization");
  return token.binding.kind === "project" ? `Only ${target}` : `Projects of ${target}`;
}

/** One API token with its status, scope, reach and expiry, and a revoke form while it is active. */
const ApiTokenRow: FC<{ token: ApiTokenSummary; bindingLabel?: string; now: number }> = ({
  token,
  bindingLabel,
  now,
}) => {
  const status = tokenStatus(token, now);
  return (
    <tr>
      <td>{token.name}</td>
      <td>
        <code>{token.tokenPrefix}…</code>
      </td>
      <td>{SCOPE_LABEL[token.scope]}</td>
      <td>{tokenAccessLabel(token, bindingLabel)}</td>
      <td>{token.expiresAt === undefined ? "Never" : formatDate(token.expiresAt)}</td>
      <td>{token.lastUsedAt === undefined ? "Never used" : formatDate(token.lastUsedAt)}</td>
      <td>{status}</td>
      <td>
        {status === "Revoked" ? (
          "—"
        ) : (
          <form method="post" action={`/settings/tokens/${token.id}/revoke`}>
            <button type="submit" class="btn btn-small btn-danger">
              Revoke
            </button>
          </form>
        )}
      </td>
    </tr>
  );
};

/**
 * Who the account is, and the two things about it that can change.
 *
 * The display name is free-form and cosmetic. The username is the namespace
 * every project URL, clone URL and backing repository is keyed on, so it can
 * be edited only while the account owns nothing that would have to be
 * rewritten — after that the row is read-only and says why.
 */
const AccountCard: FC<{
  user: SettingsUser;
  usernameChange: UsernameChange;
  fieldError?: SettingsFieldError | undefined;
  formValues?: SettingsFormValues | undefined;
}> = ({ user, usernameChange, fieldError, formValues }) => (
  <div class="card" id="account">
    <h2>Account</h2>
    <dl class="detail-list">
      <dt>Username</dt>
      <dd>@{user.username}</dd>
      <dt>Email</dt>
      <dd>{user.email}</dd>
      <dt>Member since</dt>
      <dd>{formatDate(user.createdAt)}</dd>
      {user.githubUsername !== undefined && (
        <>
          <dt>GitHub</dt>
          <dd>
            <a href={`https://github.com/${user.githubUsername}`}>@{user.githubUsername}</a>
          </dd>
        </>
      )}
    </dl>

    <form method="post" action="/settings/account" class="settings-form">
      <label>
        Display name
        <input
          {...settingsFieldAttrs(fieldError, "displayName", "settings-display-name-help")}
          type="text"
          name="displayName"
          value={formValues?.displayName ?? user.displayName ?? ""}
          maxlength={MAX_DISPLAY_NAME_LENGTH}
          placeholder={user.username}
          autocomplete="name"
        />
      </label>
      <SettingsFieldErrorText fieldError={fieldError} field="displayName" />
      <p class="settings-help" id="settings-display-name-help">
        Shown in the header instead of your username. Leave it blank to show the username.
      </p>
      <button type="submit" class="btn btn-primary">
        Save display name
      </button>
    </form>

    {usernameChange === "allowed" ? (
      // `novalidate`: POST /settings/username validates the name and re-renders
      // this form with the reason inline, so the browser's bubble is not needed.
      <form method="post" action="/settings/username" class="settings-form" novalidate>
        <label>
          Username
          <input
            {...settingsFieldAttrs(fieldError, "username", "settings-username-help")}
            type="text"
            name="username"
            value={formValues?.username ?? user.username}
            required
            minlength={3}
            maxlength={39}
            pattern={USERNAME_PATTERN}
            autocomplete="username"
            spellcheck={false}
          />
        </label>
        <SettingsFieldErrorText fieldError={fieldError} field="username" />
        <p class="settings-help" id="settings-username-help">
          {USERNAME_RULES}
        </p>
        <p class="settings-help">
          Your namespace: <code>@{user.username}/…</code> in every project and clone URL. It can be
          changed only while you own no projects; after deleting your last project, allow up to 15
          minutes.
        </p>
        <button type="submit" class="btn">
          Change username
        </button>
      </form>
    ) : usernameChange === "blocked" ? (
      <p class="settings-help">
        Your username is the namespace in every project and clone URL, so it cannot be changed while
        you own projects. If you have just deleted your last project, allow up to 15 minutes.
      </p>
    ) : (
      <p class="settings-help">
        Whether your username can change could not be confirmed just now. Reload the page to try
        again.
      </p>
    )}
  </div>
);

/**
 * Connecting a GitHub account so promoted pull requests are opened as the
 * person. The consent is this card's text: what Stratum keeps, what it will do
 * with it, and when, said before the button and not after.
 */
const GitHubConnectionCard: FC<{ connection: GitHubConnectionView }> = ({ connection }) => (
  <div class="card" id="github">
    <h2>GitHub</h2>
    <p class="settings-help">
      A pull request Stratum opens on GitHub is authored by the Stratum app unless the person
      promoting the change has connected their GitHub account here. Connected, the pull requests you
      promote are opened as you. Nobody else&rsquo;s promotion is ever opened as you.
    </p>
    {connection.state === "connected" ? (
      <>
        <p>
          Connected as <strong>@{connection.githubLogin}</strong> since{" "}
          {formatDate(connection.connectedAt)}.
        </p>
        <form method="post" action="/github/app/disconnect">
          <button type="submit" class="btn">
            Disconnect GitHub
          </button>
        </form>
        <p class="settings-help">
          Disconnecting deletes the stored authorization and asks GitHub to revoke it. Pull requests
          already opened as you stay yours.
        </p>
      </>
    ) : connection.state === "unknown" ? (
      <p class="settings-help">
        Whether your GitHub account is connected could not be checked just now. Nothing has been
        disconnected &mdash; reload the page to try again.
      </p>
    ) : connection.canConnect ? (
      <>
        <form method="post" action="/github/app/connect">
          <button type="submit" class="btn btn-primary">
            Connect GitHub
          </button>
        </form>
        <p class="settings-help">
          Stratum keeps an authorization for your GitHub account, encrypted, and uses it for one
          thing: opening the pull request when you promote a change. Through it Stratum can act as
          you only where the Stratum app is installed and you already have access. You can
          disconnect at any time, here or in your GitHub settings.
        </p>
      </>
    ) : (
      <p class="settings-help">
        Connecting needs a GitHub identity on this account, so Stratum can check that the account
        you authorize is yours. Sign in with GitHub once, then come back here.
      </p>
    )}
  </div>
);

/** The whole settings page: jump links, then one card per section in `SECTIONS` order. */
export const SettingsPage: FC<SettingsPageProps> = ({
  user,
  usernameChange,
  invites,
  shareBaseUrl,
  agents,
  apiTokens,
  tokenBindingLabels,
  oauthGrants,
  oauthGrantsUnavailable,
  freshToken,
  notice,
  fieldError,
  formValues,
  nonce,
  telemetryOptOut,
  usageNotice,
  githubConnection,
}) => {
  const now = Date.now();
  // Mirrors the server-side cap in `createApiToken`: an expired row occupies no
  // slot, so showing it as active would tell a user they are full when they can
  // still create a token.
  const activeTokens = apiTokens.filter(
    (token) => token.revokedAt === undefined && !isExpired(token.expiresAt ?? null),
  ).length;
  return (
    <Layout title="Settings" user={user} active="settings" usageNotice={usageNotice}>
      <div class="page-header">
        <h1>Settings</h1>
        <div class="header-actions">
          <a class="btn" href="/settings/security">
            Security
          </a>
          <a class="btn" href="/settings/usage">
            Usage
          </a>
        </div>
      </div>
      <nav class="section-nav" aria-label="Settings sections">
        {SECTIONS.filter(([id]) => id !== "github" || githubConnection !== undefined).map(
          ([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ),
        )}
      </nav>

      {fieldError ? (
        // An error summary: the same message as under the field, as a link that
        // moves focus to the control so it can be fixed without hunting for it.
        <div class="card card-error" role="alert">
          <p class="settings-help settings-notice">
            <a href={`#${FIELD_IDS[fieldError.field]}`}>{fieldError.message}</a>
          </p>
        </div>
      ) : (
        notice && (
          <div class={`card ${notice.kind === "error" ? "card-error" : "card-success"}`}>
            <p class="settings-help settings-notice">{notice.message}</p>
          </div>
        )
      )}

      {freshToken && (
        <div class="card settings-token-reveal">
          <h2>
            {freshToken.kind === "api-key"
              ? "Your new API key"
              : freshToken.kind === "agent"
                ? `Token for agent ${freshToken.agentName ?? ""}`
                : `Token “${freshToken.tokenName}”`}
          </h2>
          <p class="settings-help">
            Copy it now — it is shown only once.{" "}
            {freshToken.kind === "api-key" ? "Your previous key no longer works." : ""}
          </p>
          <div class="token-reveal-row">
            <code class="settings-token" id="fresh-token">
              {freshToken.value}
            </code>
            <button type="button" class="btn btn-small" id="copy-fresh-token">
              Copy
            </button>
          </div>
          {nonce !== undefined && (
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: COPY_TOKEN_SCRIPT }} />
          )}
        </div>
      )}

      <AccountCard
        user={user}
        usernameChange={usernameChange}
        fieldError={fieldError}
        formValues={formValues}
      />

      {invites !== undefined && (
        <InviteCodesCard
          invites={invites}
          {...(shareBaseUrl !== undefined ? { shareBaseUrl } : {})}
          {...(nonce !== undefined ? { nonce } : {})}
        />
      )}

      <div class="card" id="privacy">
        <h2>Privacy</h2>
        <p class="settings-help">
          Stratum can send anonymous usage analytics: one event per request and one per repository
          activity, never a URL, name, path, diff or payload. Turning this off stops future events
          for your account and your agent tokens; it does not delete events already sent.
        </p>
        <details class="settings-details">
          <summary>Exactly what is sent</summary>
          <ul class="settings-help">
            <li>
              One <code>api_request</code> per request, carrying the matched route pattern (e.g.{" "}
              <code>/:namespace/:slug/files</code>), the method, the status, and the latency.
            </li>
            <li>
              One event per repository activity (a change opening, a merge), carrying the event type
              and an opaque project id.
            </li>
          </ul>
        </details>
        <form method="post" action="/settings/telemetry" class="settings-inline-form">
          <label class="checkbox-label">
            {/*
              The missing `value` is load-bearing: browsers submit a valueless
              checked box as "on", and POST /settings/telemetry accepts only
              that literal. Adding value="1" would opt every user out, because
              the route reads an unrecognized value as an opt-out (it fails
              toward privacy). The field is also the affirmative while the
              stored column is the negative, hence the inversion here.
            */}
            <input type="checkbox" name="analytics" checked={!telemetryOptOut} />
            Send anonymous usage analytics
          </label>
          <button type="submit" class="btn btn-primary">
            Save preference
          </button>
        </form>
      </div>

      <div class="card" id="tokens">
        <h2>API tokens</h2>
        <p class="settings-help">
          Named credentials for the API, the CLI, and git over HTTPS. A read-only token can read and
          clone but never write, a token limited to a project or organization cannot reach anything
          outside it, and each token is revoked on its own.{" "}
          <a href={`${DOCS}/api/authentication/`}>How tokens work</a>.
        </p>
        {apiTokens.length === 0 ? (
          <p class="settings-help">
            No API tokens yet. Create one below — you will see its value only once.
          </p>
        ) : (
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Token</th>
                  <th>Scope</th>
                  <th>Access</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {apiTokens.map((token) => (
                  <ApiTokenRow
                    key={token.id}
                    token={token}
                    {...(tokenBindingLabels?.get(token.id) !== undefined
                      ? { bindingLabel: tokenBindingLabels.get(token.id) }
                      : {})}
                    now={now}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* `novalidate`: `parseTokenForm` checks every field and re-renders the
            form with the reason under the field it is about. */}
        <form method="post" action="/settings/tokens" class="settings-form" novalidate>
          <label>
            Token name
            <input
              {...settingsFieldAttrs(fieldError, "tokenName")}
              type="text"
              name="name"
              value={formValues?.tokenName}
              required
              maxlength={100}
              placeholder="buildkite"
            />
          </label>
          <SettingsFieldErrorText fieldError={fieldError} field="tokenName" />
          <label>
            Scope
            {/* Read-only is the default: a token created without a deliberate
                choice must not be able to write. */}
            <select name="scope">
              <option value="read" selected={formValues?.tokenScope !== "read_write"}>
                Read-only — GET/HEAD and git clone
              </option>
              <option value="read_write" selected={formValues?.tokenScope === "read_write"}>
                Read &amp; write — everything you can do
              </option>
            </select>
          </label>
          <label>
            Limit to one project (optional)
            <input
              type="text"
              name="project"
              value={formValues?.tokenProject}
              maxlength={200}
              placeholder="@owner/repo"
            />
          </label>
          <label>
            Or limit to one organization's projects (optional)
            <input
              type="text"
              name="org"
              value={formValues?.tokenOrg}
              maxlength={100}
              placeholder="acme"
            />
          </label>
          <label>
            Expires in days (optional — blank never expires)
            <input
              {...settingsFieldAttrs(fieldError, "tokenExpiry")}
              type="number"
              name="expiresInDays"
              value={formValues?.tokenExpiry}
              min={MIN_TOKEN_EXPIRY_DAYS}
              max={MAX_TOKEN_EXPIRY_DAYS}
              placeholder="90"
            />
          </label>
          <SettingsFieldErrorText fieldError={fieldError} field="tokenExpiry" />
          <button type="submit" class="btn btn-primary">
            Create token
          </button>
        </form>
        <p class="settings-help">
          {activeTokens} of {MAX_ACTIVE_TOKENS_PER_USER} active tokens used. Revoked and expired
          tokens do not count towards the limit.
        </p>
      </div>

      <div class="card" id="connections">
        <h2>Connected applications</h2>
        <p class="settings-help">
          Editors and agents you have authorized to reach Stratum over MCP at <code>/mcp</code>.
          Each one acts as you or as the agent you chose when you connected it, within the access
          you granted it. Disconnecting takes effect immediately, and an agent created for a
          connection stops working with it.
        </p>
        {oauthGrantsUnavailable ? (
          <p class="settings-help">
            Your connected applications could not be loaded, so this list is not showing them.
            Nothing has been disconnected &mdash; try again shortly.
          </p>
        ) : oauthGrants.length === 0 ? (
          <p class="settings-help">
            No applications connected. Point your editor&rsquo;s MCP client at <code>/mcp</code> on
            this instance and it will ask for access.
          </p>
        ) : (
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Application</th>
                  <th>Client ID</th>
                  <th>Access</th>
                  <th>Acts as</th>
                  <th>Connected</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {oauthGrants.map((grant) => (
                  <OAuthGrantRow key={grant.id} grant={grant} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p class="settings-help">
          An application chooses its own display name when it registers, and nobody vets it. Treat a
          name you do not recognise as untrusted and disconnect it.
        </p>
      </div>

      {githubConnection !== undefined && <GitHubConnectionCard connection={githubConnection} />}

      <div class="card" id="legacy-key">
        <h2>Legacy API key</h2>
        <p class="settings-help">
          The unnamed key every account had before API tokens existed: it never expires and has full
          read &amp; write access. Rotating replaces it; disabling makes it unusable for good. Your
          named tokens are unaffected either way.
        </p>
        <div class="settings-actions">
          <form method="post" action="/settings/rotate-token">
            <button type="submit" class="btn">
              Rotate API key
            </button>
          </form>
          <form method="post" action="/settings/legacy-token/disable">
            <button type="submit" class="btn">
              Disable legacy API key
            </button>
          </form>
        </div>
      </div>

      <div class="card" id="agents">
        <h2>Agents</h2>
        <p class="settings-help">
          Agent tokens let automated agents fork workspaces, commit, and open changes under your
          account. Reviews remain human-only.
        </p>
        {agents.length === 0 ? (
          <p class="settings-help">No agents yet.</p>
        ) : (
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>{agent.name}</td>
                    <td>{agent.model ?? "—"}</td>
                    <td>{formatDate(agent.createdAt)}</td>
                    <td>
                      <form method="post" action={`/settings/agents/${agent.id}/delete`}>
                        <button type="submit" class="btn btn-small btn-danger">
                          Revoke
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* `novalidate`: POST /settings/agents re-renders with the reason inline. */}
        <form method="post" action="/settings/agents" class="settings-form" novalidate>
          <label>
            Agent name
            <input
              {...settingsFieldAttrs(fieldError, "agentName")}
              type="text"
              name="name"
              value={formValues?.agentName}
              required
              maxlength={100}
            />
          </label>
          <SettingsFieldErrorText fieldError={fieldError} field="agentName" />
          <label>
            Model (optional)
            <input
              type="text"
              name="model"
              value={formValues?.agentModel}
              placeholder="claude-sonnet-4-6"
              maxlength={100}
            />
          </label>
          <button type="submit" class="btn btn-primary">
            Create agent token
          </button>
        </form>
      </div>

      <div class="card danger-zone" id="danger">
        <h2>Danger zone</h2>
        <p class="settings-help">
          Permanently delete your account. All your projects and personal data are erased and your
          tokens stop working immediately. Contributions you left in other people's projects are
          anonymized, not deleted. This cannot be undone. Type <code>{user.username}</code> to
          confirm.
        </p>
        <form method="post" action="/api/users/me/delete">
          <input
            type="text"
            name="confirm"
            required
            autocomplete="off"
            placeholder={user.username}
          />
          <button type="submit" class="btn btn-danger">
            Delete account
          </button>
        </form>
      </div>
    </Layout>
  );
};
