import type { FC } from "hono/jsx";

interface LayoutProps {
  title: string;
  user?: { id: string; email: string; username: string } | null | undefined;
  /** Auto-reload the page every N seconds (status polling without client JS). */
  refreshSeconds?: number;
  children?: unknown;
}

export const Layout: FC<LayoutProps> = ({ title, user, refreshSeconds, children }) => {
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
        <nav class="nav">
          <a class="nav-brand" href="/">
            stratum
          </a>
          <div class="nav-links">
            <a href="/">projects</a>
          </div>
          <div class="nav-auth">
            {user ? (
              <>
                <span class="nav-user">{user.username ?? user.email}</span>
                <a href="/settings" class="nav-auth-link">
                  settings
                </a>
                <a href="/auth/logout" class="nav-auth-link">
                  logout
                </a>
              </>
            ) : (
              <a href="/auth/email" class="nav-auth-link">
                sign in
              </a>
            )}
          </div>
        </nav>
        <main class="main">{children}</main>
      </body>
    </html>
  );
};
