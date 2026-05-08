/**
 * Seed a preview (or local) Stratum environment with sample projects and workspaces.
 *
 * Usage:
 *   STRATUM_URL=https://pr-45.staging.app.usestratum.dev \
 *   STRATUM_SESSION=<cookie value> \
 *   npx tsx scripts/seed-preview.ts
 *
 * How to get your session cookie:
 *   1. Sign in at the preview URL
 *   2. Open DevTools → Application → Cookies
 *   3. Copy the value of `stratum_session`
 *
 * You can also pass a Bearer token (stratum_user_...) via STRATUM_TOKEN
 * instead of a session cookie if you have one.
 */

const BASE_URL = process.env.STRATUM_URL?.replace(/\/$/, "") ?? "http://localhost:8787";
const SESSION = process.env.STRATUM_SESSION;
const TOKEN = process.env.STRATUM_TOKEN;

if (!SESSION && !TOKEN) {
  console.error("❌ Set STRATUM_SESSION or STRATUM_TOKEN");
  console.error(
    "   STRATUM_SESSION: copy stratum_session cookie from DevTools → Application → Cookies",
  );
  process.exit(1);
}

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (TOKEN) {
  headers["Authorization"] = `Bearer ${TOKEN}`;
} else if (SESSION) {
  headers["Cookie"] = `stratum_session=${SESSION}`;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  });
  return res;
}

async function createProject(name: string, seed = true) {
  const res = await apiFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, visibility: "private", seed }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create project '${name}': ${res.status} ${body}`);
  }
  return res.json<{ id: string; namespace: string; slug: string; path: string }>();
}

async function createWorkspace(namespace: string, slug: string, workspaceName: string) {
  const res = await apiFetch(`/api/projects/${namespace}/${slug}/workspaces`, {
    method: "POST",
    body: JSON.stringify({ name: workspaceName }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create workspace '${workspaceName}': ${res.status} ${body}`);
  }
  return res.json<{ name: string; branchName: string }>();
}

async function whoami() {
  const res = await apiFetch("/api/users/me");
  if (!res.ok) throw new Error(`Auth check failed: ${res.status} — check your session/token`);
  return res.json<{ id: string; email: string; username: string }>();
}

async function main() {
  console.log(`\n🌱 Seeding ${BASE_URL}\n`);

  const me = await whoami();
  console.log(`✓ Authenticated as ${me.email}\n`);

  const projects = [
    { name: "demo-app", workspaces: ["feature-auth", "feature-ui"] },
    { name: "api-service", workspaces: ["fix-timeout"] },
    { name: "data-pipeline", workspaces: [] },
  ];

  for (const { name, workspaces } of projects) {
    process.stdout.write(`  Creating project '${name}'... `);
    let project: Awaited<ReturnType<typeof createProject>>;
    try {
      project = await createProject(name, true);
      console.log(`✓  ${BASE_URL}/${project.path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        console.log("already exists, skipping");
        continue;
      }
      console.log(`❌  ${msg}`);
      continue;
    }

    const ns = project.namespace;
    const sl = project.slug;

    for (const wsName of workspaces) {
      process.stdout.write(`    Creating workspace '${wsName}'... `);
      try {
        const ws = await createWorkspace(ns, sl, wsName);
        console.log(`✓  (branch: ${ws.branchName})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists")) {
          console.log("already exists, skipping");
        } else {
          console.log(`❌  ${msg}`);
        }
      }
    }
  }

  console.log("\n✅ Done. Visit the preview to explore:");
  console.log(`   ${BASE_URL}\n`);
}

main().catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
