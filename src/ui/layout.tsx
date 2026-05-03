import type { FC } from "hono/jsx";

interface LayoutProps {
  title: string;
  user?: { id: string; email: string } | null | undefined;
  children?: unknown;
}

export const Layout: FC<LayoutProps> = ({ title, user, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
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
                <span class="nav-user">{user.email}</span>
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
