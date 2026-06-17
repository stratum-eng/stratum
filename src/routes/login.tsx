import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  email_not_found: "No account found with this email.",
  auth_config_missing: "Email authentication is not configured. Please contact the administrator.",
  auth_config_incomplete:
    "Email authentication is not fully configured. Please contact the administrator.",
  send_failed: "Failed to send email. Please try again later.",
  rate_limited: "Too many requests. Please try again in an hour.",
};

const SUCCESS_MESSAGES: Record<string, string> = {
  email_sent: "Check your email. We sent a magic link that expires in 15 minutes.",
};

// GET /auth/login - Show login form
app.get("/", (c) => {
  const errorCode = c.req.query("error");
  const successCode = c.req.query("success");
  const error =
    errorCode !== undefined ? (ERROR_MESSAGES[errorCode] ?? "Authentication failed.") : undefined;
  const success = successCode !== undefined ? SUCCESS_MESSAGES[successCode] : undefined;
  const isEmailNotFound = errorCode === "email_not_found";

  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Sign In — Stratum</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%230d0d0d'/%3E%3Ctext%20x='16'%20y='23'%20font-family='monospace'%20font-size='20'%20font-weight='700'%20fill='%237ca9f7'%20text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E"
        />
        <link rel="stylesheet" href="/ui.css" />
        <style>{`
          :root {
            --bg-primary: #0a0a0a;
            --bg-secondary: #111;
            --bg-tertiary: #1a1a1a;
            --text-primary: #f0f0f0;
            --text-secondary: #888;
            --text-tertiary: #666;
            --border: #1e1e1e;
            --border-hover: #333;
            --accent: #1a3a6e;
            --accent-hover: #1f4a8e;
            --accent-text: #7ca9f7;
            --accent-text-hover: #a8c8f8;
            --error-bg: rgba(248, 113, 113, 0.1);
            --error-border: rgba(248, 113, 113, 0.3);
            --error-text: #f87171;
            --success-bg: rgba(74, 222, 128, 0.1);
            --success-border: rgba(74, 222, 128, 0.3);
            --success-text: #4ade80;
          }

          .auth-page {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            background: var(--bg-primary);
          }

          .auth-container {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem 1rem;
          }

          .auth-card {
            width: 100%;
            max-width: 400px;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 2rem;
          }

          .auth-header {
            text-align: center;
            margin-bottom: 1.5rem;
          }

          .auth-title {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 0.5rem;
          }

          .auth-subtitle {
            font-size: 0.9rem;
            color: var(--text-secondary);
            line-height: 1.5;
          }

          .alert {
            padding: 0.875rem 1rem;
            border-radius: 6px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
            line-height: 1.5;
          }

          .alert-error {
            background: var(--error-bg);
            border: 1px solid var(--error-border);
            color: var(--error-text);
          }

          .alert-success {
            background: var(--success-bg);
            border: 1px solid var(--success-border);
            color: var(--success-text);
          }

          .error-action {
            margin-top: 0.75rem;
            padding-top: 0.75rem;
            border-top: 1px solid var(--error-border);
          }

          .error-action a {
            color: var(--error-text);
            font-weight: 500;
            text-decoration: underline;
          }

          .form-group {
            margin-bottom: 1.25rem;
          }

          .form-label {
            display: block;
            font-size: 0.85rem;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
          }

          .form-input {
            width: 100%;
            padding: 0.75rem 1rem;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text-primary);
            font-family: inherit;
            font-size: 1rem;
            transition: border-color 0.15s, box-shadow 0.15s;
          }

          .form-input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(26, 58, 110, 0.3);
          }

          .form-input::placeholder {
            color: var(--text-tertiary);
          }

          .form-checkbox-group {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 1.5rem;
          }

          .form-checkbox {
            width: 1rem;
            height: 1rem;
            accent-color: var(--accent);
            cursor: pointer;
          }

          .form-checkbox-label {
            font-size: 0.85rem;
            color: var(--text-secondary);
            cursor: pointer;
            user-select: none;
          }

          .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            padding: 0.75rem 1rem;
            background: var(--accent);
            border: 1px solid var(--accent);
            border-radius: 6px;
            color: white;
            font-family: inherit;
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
            text-decoration: none;
          }

          .btn:hover {
            background: var(--accent-hover);
            border-color: var(--accent-hover);
            text-decoration: none;
          }

          .btn:focus {
            outline: none;
            box-shadow: 0 0 0 3px rgba(26, 58, 110, 0.3);
          }

          .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          .btn-secondary {
            background: transparent;
            border-color: var(--border-hover);
            color: var(--text-primary);
          }

          .btn-secondary:hover {
            background: var(--bg-tertiary);
            border-color: var(--border-hover);
          }

          .btn-github {
            background: #333;
            border-color: #333;
            color: white;
          }

          .btn-github:hover {
            background: #444;
            border-color: #444;
          }

          .auth-divider {
            display: flex;
            align-items: center;
            margin: 1.5rem 0;
            color: var(--text-tertiary);
            font-size: 0.85rem;
          }

          .auth-divider::before,
          .auth-divider::after {
            content: "";
            flex: 1;
            height: 1px;
            background: var(--border);
          }

          .auth-divider::before {
            margin-right: 1rem;
          }

          .auth-divider::after {
            margin-left: 1rem;
          }

          .auth-footer {
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border);
            text-align: center;
          }

          .auth-footer-text {
            font-size: 0.9rem;
            color: var(--text-secondary);
          }

          .auth-footer a {
            color: var(--accent-text);
            font-weight: 500;
          }

          .auth-footer a:hover {
            color: var(--accent-text-hover);
            text-decoration: underline;
          }

          .auth-help {
            margin-top: 1rem;
            font-size: 0.85rem;
            color: var(--text-tertiary);
            text-align: center;
            line-height: 1.5;
          }

          .auth-help-icon {
            display: inline-block;
            width: 16px;
            height: 16px;
            margin-right: 0.25rem;
            vertical-align: middle;
          }

          .magic-link-note {
            margin-top: 1.5rem;
            padding: 1rem;
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 6px;
            font-size: 0.85rem;
            color: var(--text-secondary);
            line-height: 1.5;
          }

          .magic-link-note strong {
            color: var(--text-primary);
            display: block;
            margin-bottom: 0.25rem;
          }

          .success-state {
            text-align: center;
            padding: 1rem 0;
          }

          .success-icon {
            width: 48px;
            height: 48px;
            margin: 0 auto 1rem;
            color: var(--success-text);
          }

          .success-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-primary);
            margin-bottom: 0.5rem;
          }

          .success-message {
            font-size: 0.9rem;
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
          }

          /* Responsive adjustments */
          @media (max-width: 480px) {
            .auth-card {
              padding: 1.5rem;
            }

            .auth-title {
              font-size: 1.25rem;
            }
          }
        `}</style>
      </head>
      <body class="auth-page">
        <nav class="nav">
          <a class="nav-brand" href="/">
            stratum
          </a>
        </nav>
        <main class="auth-container">
          <div class="auth-card">
            {success ? (
              <div class="success-state">
                <div class="success-icon">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    role="img"
                    aria-label="Success"
                  >
                    <title>Success</title>
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
                <h2 class="success-title">Check your email</h2>
                <p class="success-message">{success}</p>
                <a href="/" class="btn btn-secondary">
                  Back to Home
                </a>
              </div>
            ) : (
              <>
                <div class="auth-header">
                  <h1 class="auth-title">Sign in to Stratum</h1>
                  <p class="auth-subtitle">
                    Enter your email to receive a secure magic link for instant sign in.
                  </p>
                </div>

                {error && (
                  <div class="alert alert-error">
                    {error}
                    {isEmailNotFound && (
                      <div class="error-action">
                        <a href="/auth/signup">Create an account instead →</a>
                      </div>
                    )}
                  </div>
                )}

                <form action="/auth/email/send-login" method="post">
                  <div class="form-group">
                    <label class="form-label" for="email">
                      Email address
                    </label>
                    <input
                      class="form-input"
                      type="email"
                      id="email"
                      name="email"
                      placeholder="you@example.com"
                      required
                      autoComplete="email"
                    />
                  </div>

                  <div class="form-checkbox-group">
                    <input
                      class="form-checkbox"
                      type="checkbox"
                      id="rememberMe"
                      name="rememberMe"
                      value="true"
                      defaultChecked
                    />
                    <label class="form-checkbox-label" for="rememberMe">
                      Keep me signed in for 30 days
                    </label>
                  </div>

                  <button type="submit" class="btn">
                    Sign In
                  </button>
                </form>

                <div class="auth-help">
                  <span class="auth-help-icon">🔐</span>
                  <strong>No password needed.</strong> We use secure magic links that expire in 15
                  minutes. Check your spam folder if you don't see the email.
                </div>

                <div class="auth-divider">or</div>

                <a href="/auth/github" class="btn btn-github">
                  <svg
                    style={{ marginRight: "0.5rem" }}
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    role="img"
                    aria-label="GitHub"
                  >
                    <title>GitHub</title>
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  Continue with GitHub
                </a>

                <a href="/auth/google" class="btn btn-github" style={{ marginTop: "0.5rem" }}>
                  <svg
                    style={{ marginRight: "0.5rem" }}
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    role="img"
                    aria-label="Google"
                  >
                    <title>Google</title>
                    <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
                  </svg>
                  Continue with Google
                </a>

                <div class="auth-footer">
                  <p class="auth-footer-text">
                    Don't have an account? <a href="/auth/signup">Sign up</a>
                  </p>
                </div>
              </>
            )}
          </div>
        </main>
      </body>
    </html>,
  );
});

export { app as loginRouter };
