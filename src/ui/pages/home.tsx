import type { FC } from "hono/jsx";
import type { UsageBannerNotice } from "../../billing/usage-banner";
import { Layout } from "../layout";

interface HomeProps {
  projects: Array<{
    name: string;
    namespace: string;
    slug: string;
    remote: string;
    createdAt: string;
    visibility?: string;
  }>;
  user?: { id: string; email: string; username: string } | null;
  /** The 80% warning, when this account has one. See `Layout`. */
  usageNotice?: UsageBannerNotice | null;
}

export const HomePage: FC<HomeProps> = ({ projects, user, usageNotice }) => {
  return (
    <Layout title="Dashboard" user={user} usageNotice={usageNotice}>
      <div class="page-header">
        <h1>Dashboard</h1>
        {user && (
          <a class="btn btn-primary" href="/new">
            New Project
          </a>
        )}
      </div>
      {projects.length === 0 ? (
        <div class="empty-state">
          {user ? (
            <>
              <p>No projects yet.</p>
              <a
                href="/new"
                class="btn btn-primary"
                style={{ marginTop: "1rem", display: "inline-block" }}
              >
                Create your first project
              </a>
            </>
          ) : (
            <>
              <p>Sign in to view your projects.</p>
              <a
                href="/auth/login"
                class="btn btn-primary"
                style={{ marginTop: "1rem", display: "inline-block" }}
              >
                Sign in
              </a>
            </>
          )}
        </div>
      ) : (
        <div class="card-grid">
          {projects.map((project) => (
            <a
              class="card card-link"
              href={`/${project.namespace}/${project.slug}`}
              key={project.name}
            >
              <div class="card-title">
                {project.name}
                {project.visibility === "public" && <span class="badge badge-public">public</span>}
              </div>
              <div class="card-meta">
                {project.namespace}/{project.slug}
              </div>
              <div class="card-meta">
                Created {new Date(project.createdAt).toLocaleDateString()}
              </div>
            </a>
          ))}
        </div>
      )}
    </Layout>
  );
};
