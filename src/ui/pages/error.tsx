import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { getUser } from "../../storage/users";
import type { Env } from "../../types";
import { createLogger } from "../../utils/logger";
import { Layout } from "../layout";

const STATUS_COPY: Record<400 | 403 | 404 | 500, { title: string; hint: string }> = {
  400: {
    title: "Bad request",
    hint: "The address is not a valid Stratum path. Check the URL for typos.",
  },
  403: {
    title: "Forbidden",
    hint: "You don't have permission to view this page.",
  },
  404: {
    title: "Page not found",
    hint: "This page doesn't exist, or you don't have access to it.",
  },
  500: {
    title: "Something went wrong",
    hint: "An unexpected error occurred on our side. Try again in a moment.",
  },
};

interface ErrorPageProps {
  status: 400 | 403 | 404 | 500;
  /** Optional specific message, shown in place of the generic hint. */
  message?: string;
  user?: { id: string; email: string; username: string } | null;
}

export const ErrorPage: FC<ErrorPageProps> = ({ status, message, user }) => {
  const copy = STATUS_COPY[status];
  return (
    <Layout title={copy.title} user={user}>
      <div class="error-page">
        <p class="error-page-code" aria-hidden="true">
          {status}
        </p>
        <h1 class="error-page-title">{copy.title}</h1>
        <p class="error-page-hint">{message ?? copy.hint}</p>
        <div class="error-page-actions">
          <a class="btn btn-primary" href="/">
            Go to dashboard
          </a>
          {!user && (
            <a class="btn" href="/auth/login">
              Sign in
            </a>
          )}
        </div>
      </div>
    </Layout>
  );
};

type ErrorContext = Context<{ Bindings: Env }>;

/**
 * Browsers navigating to a bad URL should get a real page, not raw JSON —
 * but the JSON contract stays intact for API paths and any client that
 * doesn't ask for HTML (CLI, agents, fetch without an Accept header).
 */
function wantsHtml(c: ErrorContext): boolean {
  if (c.req.path.startsWith("/api/")) return false;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return false;
  return (c.req.header("Accept") ?? "").includes("text/html");
}

/** Best-effort current user for the error page's nav; never fails the response. */
async function currentUser(
  c: ErrorContext,
): Promise<{ id: string; email: string; username: string } | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const result = await getUser(c.env.DB, userId, createLogger({ path: c.req.path, userId }));
  return result.success ? result.data : null;
}

export async function notFoundResponse(c: ErrorContext): Promise<Response> {
  if (!wantsHtml(c)) return c.json({ error: "Not found" }, 404);
  return c.html(<ErrorPage status={404} user={await currentUser(c)} />, 404);
}

export async function serverErrorResponse(c: ErrorContext): Promise<Response> {
  if (!wantsHtml(c)) return c.json({ error: "Internal server error" }, 500);
  // No user lookup here: the failure may well be the database itself.
  return c.html(<ErrorPage status={500} />, 500);
}
