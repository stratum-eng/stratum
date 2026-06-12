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
