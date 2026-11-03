import type { FC } from "hono/jsx";
import { CSS } from "./styles";

/**
 * FNV-1a, 32-bit. Not for security — only to give the stylesheet a URL that
 * changes exactly when its content does, computed once at module load
 * (synchronously, which `crypto.subtle.digest` is not).
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Changes whenever the stylesheet does, so its URL can be cached forever. */
export const CSS_VERSION = fnv1a(CSS);

/** Versioned stylesheet URL: `/ui.css` serves it `immutable` for this version. */
export const STYLESHEET_HREF = `/ui.css?v=${CSS_VERSION}`;

const FONT_CSS_HREF =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap";

/**
 * Everything a page needs for Stratum's styling, for a `<head>`.
 *
 * The font is linked here rather than `@import`ed from the stylesheet: an
 * import is only discovered once the stylesheet has downloaded, so the browser
 * fetched HTML, then CSS, then the font CSS, then the font, one after another.
 * Linked from the head, with the two font origins pre-connected, the font loads
 * in parallel with the stylesheet.
 */
export const StylesheetLinks: FC = () => (
  <>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
    <link rel="stylesheet" href={STYLESHEET_HREF} />
    <link rel="stylesheet" href={FONT_CSS_HREF} />
  </>
);

/** {@link StylesheetLinks} as a string, for the few pages built without JSX. */
export const STYLESHEET_LINKS_HTML = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">',
  `<link rel="stylesheet" href="${STYLESHEET_HREF}">`,
  `<link rel="stylesheet" href="${FONT_CSS_HREF}">`,
].join("");
