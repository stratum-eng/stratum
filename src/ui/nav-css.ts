/**
 * The site header, shared verbatim between the app and the docs site.
 *
 * app.usestratum.dev renders it from `src/ui/layout.tsx` with this stylesheet
 * spliced into `src/ui/styles.ts`; docs.usestratum.dev renders the same markup
 * from `website/src/components/Header.astro` against a generated copy of this
 * file. `website/scripts/mirror-header.mjs` writes that copy into
 * `website/src/styles/header.css` (along with the design tokens the rules below
 * reference, read out of `styles.ts`), and `npm run check:header` in `website/`
 * fails the build if it has drifted.
 *
 * So: edit the header here. Never edit `website/src/styles/header.css` — the
 * next sync overwrites it — and keep the rules self-contained, since the docs
 * site has none of the app's other styles. The one thing the copy does not
 * carry is the token *values*: the mirror emits them for the app's dark chrome,
 * and the docs site remaps them for its light theme in `theme.css`.
 */
export const NAV_CSS = `
.nav {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 0.35rem 1.25rem;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.6;
}

.nav a { text-decoration: none; }

.nav-brand {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.05em;
  margin-right: auto;
}
.nav-brand:hover { text-decoration: none; color: var(--accent-text); }

.nav-auth {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.nav-user {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.nav-auth-link {
  color: var(--accent-text);
  font-size: 0.9rem;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  white-space: nowrap;
  transition: background 0.15s;
}

.nav-auth-link:hover {
  background: var(--accent);
  text-decoration: none;
}

/* The link to the page the reader is on: quiet, not clickable-blue. */
.nav-auth-link[aria-current="page"] {
  color: var(--text-primary);
  background: var(--bg-raised);
}

.nav-logout-form { display: inline; }
button.nav-auth-link {
  background: none; border: none; cursor: pointer;
  font-family: inherit; font-size: 0.9rem; line-height: inherit;
}

/*
 * The phone menu. A nav that carries the toggle (the app, when signed in)
 * collapses its links behind a "menu" button below 640px; one without it (the
 * docs site, the signed-out app) keeps them inline, since a lone "sign in"
 * fits. The toggle is a checkbox so the menu works with no client script: the
 * label is the button, and the checked state shows the links. Below 640px the
 * input is visually hidden rather than display:none so it keeps its place in
 * the tab order and the label shows its focus ring; at wider widths it is
 * display:none, because a control with no visible label must not be reachable
 * by Tab.
 */
.nav-menu-toggle { display: none; }
.nav-menu-button { display: none; }
.nav-menu-close { display: none; }

@media (max-width: 640px) {
  .nav { padding: 0.6rem 1rem; }

  .nav-menu-toggle {
    display: block;
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .nav-menu-button {
    display: inline-block;
    color: var(--accent-text);
    font-size: 0.9rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
  }
  .nav-menu-button:hover { background: var(--accent); }
  .nav-menu-toggle:focus-visible ~ .nav-menu-button {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
  .nav-menu-toggle:checked ~ .nav-menu-button .nav-menu-open { display: none; }
  .nav-menu-toggle:checked ~ .nav-menu-button .nav-menu-close { display: inline; }

  .nav-menu-toggle ~ .nav-auth {
    display: none;
    flex-basis: 100%;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    margin-top: 0.35rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--border);
  }
  .nav-menu-toggle:checked ~ .nav-auth { display: flex; }
  .nav-menu-toggle ~ .nav-auth .nav-user { padding: 0.5rem; }
  .nav-menu-toggle ~ .nav-auth .nav-logout-form { display: block; }
  /* Full-width rows at least 44px tall, so a thumb hits one link and not two. */
  .nav-menu-toggle ~ .nav-auth .nav-auth-link {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.5rem;
    text-align: left;
  }
}
`;
