import type { FC } from "hono/jsx";
import type { RepoTagEntry } from "../../storage/git-ops";
import { Layout } from "../layout";

interface TagsProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
  };
  tags: RepoTagEntry[];
  user?: { id: string; email: string; username: string } | null;
}

/**
 * Formats a tagger timestamp as a day, abbreviated month, and year.
 *
 * @param timestamp - The timestamp in epoch seconds.
 * @returns The formatted date, or an empty string when the timestamp is absent or invalid.
 */
export function formatTagDate(timestamp: number | undefined): string {
  if (timestamp === undefined) return "";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export const TagsPage: FC<TagsProps> = ({ project, tags, user }) => {
  return (
    <Layout title={`Tags — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>Tags</h1>
        <a class="btn" href={`/${project.namespace}/${project.slug}`}>
          Back to repo
        </a>
      </div>

      {tags.length === 0 ? (
        <div class="empty-state">
          <p>No tags yet.</p>
          <p class="empty-state-hint">
            Push a tag to a workspace remote to create one — the project remote refuses tag pushes.
          </p>
        </div>
      ) : (
        <div class="card">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Type</th>
                  <th>Target</th>
                  <th>Message</th>
                  <th>Tagger</th>
                  <th>Tagged</th>
                </tr>
              </thead>
              <tbody>
                {tags.map((tag) => (
                  <tr key={tag.name}>
                    <td class="mono">{tag.name}</td>
                    <td>
                      <span class={`badge ${tag.annotated ? "badge-open" : ""}`}>
                        {tag.annotated ? "annotated" : "lightweight"}
                      </span>
                    </td>
                    <td class="mono">
                      {/* A tag pointing outside the shallow clone window is still
                          shown, marked unresolvable, never an error. */}
                      {tag.unresolvable ? (
                        <span class="badge badge-rejected" title={tag.targetSha ?? tag.oid}>
                          unresolvable
                        </span>
                      ) : (
                        (tag.targetSha ?? tag.oid).slice(0, 7)
                      )}
                    </td>
                    <td>{tag.message ?? ""}</td>
                    {/* Lightweight tags carry no tagger; blank rather than a
                        placeholder, matching the Message cell above. */}
                    <td>{tag.tagger ?? ""}</td>
                    <td>{formatTagDate(tag.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
};
