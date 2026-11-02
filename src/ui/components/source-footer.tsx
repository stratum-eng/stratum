import type { FC } from "hono/jsx";
import { STRATUM_SOURCE_URL, STRATUM_VERSION } from "../../version";

export { STRATUM_SOURCE_URL };

/**
 * The AGPL-3.0 §13 source offer, rendered in the chrome of every page Stratum
 * serves.
 *
 * §13 asks an operator running a *modified* Stratum to prominently offer that
 * version's Corresponding Source to everyone who interacts with the instance
 * over the network. "Everyone" includes a visitor who never signs in, so this
 * belongs on the standalone auth and OAuth-consent documents as much as on the
 * shared `Layout` — those pages are the only Stratum such a visitor ever sees.
 *
 * Three renderings, one set of facts. Most pages are JSX and use
 * {@link SourceFooter}; a few are built from template strings and use
 * {@link SOURCE_FOOTER_HTML}; the magic-link verify page links no stylesheet at
 * all and uses {@link SOURCE_FOOTER_HTML_INLINE}. They cannot drift on the
 * substance — version, license, license text, source URL — because all three
 * are built from the constants below, and `tests/source-offer.test.tsx` asserts
 * every rendering carries all four. That suite also fails if any file in `src/`
 * grows a `</body>` without an offer, which is how the two template-string
 * pages were found in the first place.
 */
/**
 * The full SPDX identifier, not the bare "AGPL-3.0". The repository is
 * AGPL-3.0-**or-later**, and a notice naming only version 3 understates the
 * grant a reader is being given. `tests/source-offer.test.tsx` pins this to
 * package.json's `license` field so the visible notice and the manifest cannot
 * disagree.
 */
export const LICENSE_NAME = "AGPL-3.0-or-later";
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

export const SourceFooter: FC = () => (
  <footer class="site-footer">
    <span>stratum v{STRATUM_VERSION}</span>
    <span class="site-footer-sep">·</span>
    <a href={LICENSE_URL} target="_blank" rel="license noopener noreferrer">
      {LICENSE_NAME}
    </a>
    <span class="site-footer-sep">·</span>
    <a href={STRATUM_SOURCE_URL} target="_blank" rel="noopener noreferrer">
      source
    </a>
  </footer>
);

/** The offer as raw HTML, styled by `.site-footer` in the shared stylesheet. */
export const SOURCE_FOOTER_HTML = `<footer class="site-footer"><span>stratum v${STRATUM_VERSION}</span><span class="site-footer-sep">·</span><a href="${LICENSE_URL}" target="_blank" rel="license noopener noreferrer">${LICENSE_NAME}</a><span class="site-footer-sep">·</span><a href="${STRATUM_SOURCE_URL}" target="_blank" rel="noopener noreferrer">source</a></footer>`;

/**
 * The offer for a document that links no stylesheet — today only the magic-link
 * verify page, which is deliberately a bare, light-background page and would be
 * restyled, not decorated, by pulling in `/ui.css`. Muted but above the
 * contrast floor on white: a legal notice nobody can read is not an offer.
 *
 * One line on purpose. A newline inside the literal would become rendered
 * whitespace around the separators, and this variant has no flex container to
 * swallow it.
 */
export const SOURCE_FOOTER_HTML_INLINE = `<footer style="margin-top:2.5rem;font-size:0.8rem;color:#555">stratum v${STRATUM_VERSION} · <a href="${LICENSE_URL}" target="_blank" rel="license noopener noreferrer" style="color:#555">${LICENSE_NAME}</a> · <a href="${STRATUM_SOURCE_URL}" target="_blank" rel="noopener noreferrer" style="color:#555">source</a></footer>`;
