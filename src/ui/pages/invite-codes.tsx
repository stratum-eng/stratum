import type { FC } from "hono/jsx";
import type { InviteCodeStatus, InviteCodesResult } from "../../beta/gate";
import { formatDate } from "../format";

/** The referral link for `code`, or null when there is no origin to build it on (the bare code is shown instead). */
function shareLink(base: string | undefined, code: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/?ref=${encodeURIComponent(code)}`;
}

/**
 * Copies the text of the element named by `data-copy-target`. One delegated
 * listener rather than a script per row, and the value is read out of the DOM
 * instead of being interpolated into JS — a code must never reach a script
 * body, where escaping it correctly is a fresh chance to get it wrong.
 */
const COPY_CODE_SCRIPT = `
(function () {
  var buttons = document.querySelectorAll('[data-copy-target]');
  Array.prototype.forEach.call(buttons, function (btn) {
    var target = document.getElementById(btn.getAttribute('data-copy-target'));
    if (!target) return;
    var label = btn.textContent;
    btn.addEventListener('click', function () {
      // Clipboard API can be missing (insecure context) or blocked by policy;
      // fall back to selecting the value so a manual Ctrl/Cmd+C still works.
      var fallback = function () {
        var range = document.createRange();
        range.selectNodeContents(target);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Ctrl/Cmd+C';
        setTimeout(function () { btn.textContent = label; }, 3000);
      };
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        fallback();
        return;
      }
      navigator.clipboard.writeText(target.textContent).then(function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = label; }, 2000);
      }, fallback);
    });
  });
})();
`;

/** One invite code: its link or bare code, whether it is still available, and a copy button only while it is. */
const InviteCodeRow: FC<{ entry: InviteCodeStatus; index: number; shareBaseUrl?: string }> = ({
  entry,
  index,
  shareBaseUrl,
}) => {
  const redeemed = entry.redeemedAt !== null;
  const link = shareLink(shareBaseUrl, entry.code);
  // The id only has to be unique within the page; the code itself is not used,
  // so a code containing characters illegal in an id cannot break the wiring.
  const linkId = `invite-link-${index}`;
  const codeId = `invite-code-${index}`;
  return (
    <tr>
      <td>
        <code class="mono" id={codeId}>
          {entry.code}
        </code>
      </td>
      <td>
        {link === null ? (
          <span class="text-muted">—</span>
        ) : (
          <code class="mono invite-share-link" id={linkId}>
            {link}
          </code>
        )}
      </td>
      <td>
        {redeemed ? (
          <span class="badge badge-merged">
            Redeemed {entry.redeemedAt === null ? "" : formatDate(entry.redeemedAt)}
            {entry.redeemedBy === null ? "" : ` by ${entry.redeemedBy}`}
          </span>
        ) : (
          <span class="badge badge-open">Available</span>
        )}
      </td>
      <td>
        {redeemed ? (
          <span class="text-muted">—</span>
        ) : (
          <button
            type="button"
            class="btn btn-small"
            data-copy-target={link === null ? codeId : linkId}
          >
            Copy
          </button>
        )}
      </td>
    </tr>
  );
};

/**
 * The caller's own closed-beta invite codes, as a settings card. Rendered only
 * when a referral service is configured; the three states (codes, none,
 * service unreachable) are deliberately distinct, since "you have no codes"
 * must never be shown over an outage.
 */
export const InviteCodesCard: FC<{
  invites: InviteCodesResult;
  shareBaseUrl?: string;
  /** Per-request CSP nonce for the copy-button script. */
  nonce?: string;
}> = ({ invites, shareBaseUrl, nonce }) => {
  const codes = invites.status === "ok" ? invites.codes : [];
  const available = codes.filter((entry) => entry.redeemedAt === null).length;
  return (
    <div class="card" id="invites">
      <h2>Invite codes</h2>
      {invites.status === "unavailable" ? (
        <p class="settings-help settings-help-error">
          Your invite codes could not be loaded right now. This is a temporary problem reaching the
          invite service — your codes have not been lost. Try again shortly.
        </p>
      ) : codes.length === 0 ? (
        <p class="settings-help">
          You have no invite codes. Codes are issued when you join through the closed beta; if you
          signed up while signups were open, there is nothing to share here.
        </p>
      ) : (
        <>
          <p class="settings-help">
            Each code lets one person create an account. Send someone the share link and their code
            is filled in for them at signup. {available} of {codes.length}{" "}
            {codes.length === 1 ? "code is" : "codes are"} still available.
          </p>
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Share link</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {codes.map((entry, index) => (
                  <InviteCodeRow
                    key={entry.code}
                    entry={entry}
                    index={index}
                    {...(shareBaseUrl !== undefined ? { shareBaseUrl } : {})}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {nonce !== undefined && (
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: COPY_CODE_SCRIPT }} />
          )}
        </>
      )}
    </div>
  );
};
