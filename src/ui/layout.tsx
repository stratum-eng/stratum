import type { FC } from "hono/jsx";
import { SourceFooter } from "./components/source-footer";

/**
 * A closed union rather than a free string: the header renders exactly these
 * links, so a page cannot claim an "active" link that does not exist, and
 * adding a link means adding it here where the compiler lists every caller.
 */
export type NavItem = "new" | "settings";

interface LayoutProps {
  title: string;
  user?:
    | { id: string; email: string; username: string; displayName?: string | undefined }
    | null
    | undefined;
  /** Auto-reload the page every N seconds (status polling without client JS). */
  refreshSeconds?: number;
  /**
   * Set by the page, not derived from the request path: the layout does not
   * see the URL, and a page under /new/import is still "new" to the reader.
   */
  active?: NavItem;
  children?: unknown;
}

/** The page chrome shared by every server-rendered page: header nav, main column, footer, and the CSP-nonced scripts. */
export const Layout: FC<LayoutProps> = ({ title, user, refreshSeconds, active, children }) => {
  const current = (item: NavItem) => (active === item ? "page" : undefined);
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {refreshSeconds !== undefined && (
          <meta http-equiv="refresh" content={String(refreshSeconds)} />
        )}
        <title>{title} — Stratum</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%230d0d0d'/%3E%3Ctext%20x='16'%20y='23'%20font-family='monospace'%20font-size='20'%20font-weight='700'%20fill='%237ca9f7'%20text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E"
        />
        <link rel="stylesheet" href="/ui.css" />
      </head>
      <body>
        {/*
          `data-ph` is the click identifier browser analytics reports (see
          src/analytics/web-snippet.ts). The value must be a literal written
          here — never interpolated from a project, file or user name — and
          only `[a-z][a-z0-9-]*` is accepted; anything else is dropped before
          it leaves the browser rather than trusted.
        */}
        <nav class="nav">
          <a class="nav-brand" href="/" data-ph="nav-home">
            stratum
          </a>
          {user && (
            <>
              {/*
                A checkbox, not a button: the phone menu's open/closed state
                has to live somewhere with no client script, and :checked is
                the only state CSS can read. The label is the visible button;
                on phones the input is visually hidden but kept in the tab
                order, and at wider widths both are display:none.
              */}
              <input type="checkbox" id="nav-menu" class="nav-menu-toggle" />
              <label for="nav-menu" class="nav-menu-button">
                <span class="nav-menu-open">menu</span>
                <span class="nav-menu-close">close</span>
              </label>
            </>
          )}
          <div class="nav-auth">
            {user ? (
              <>
                {/* Identity, not navigation: who is signed in. The account page is "settings". */}
                <span class="nav-user" title={`@${user.username}`}>
                  {user.displayName ?? user.username ?? user.email}
                </span>
                <a
                  href="/new"
                  class="nav-auth-link"
                  data-ph="nav-new-project"
                  aria-current={current("new")}
                >
                  new project
                </a>
                <a
                  href="/settings"
                  class="nav-auth-link"
                  data-ph="nav-settings"
                  aria-current={current("settings")}
                >
                  settings
                </a>
                <form method="post" action="/auth/logout" class="nav-logout-form">
                  <button type="submit" class="nav-auth-link" data-ph="nav-logout">
                    logout
                  </button>
                </form>
              </>
            ) : (
              <a href="/auth/login" class="nav-auth-link" data-ph="nav-sign-in">
                sign in
              </a>
            )}
          </div>
        </nav>
        <main class="main">{children}</main>
        <SourceFooter />
      </body>
    </html>
  );
};
