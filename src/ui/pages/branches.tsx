import type { FC } from "hono/jsx";
import type { RepoBranchEntry } from "../../storage/git-ops";
import { refQuery } from "../components/file-tree";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface BranchSwitcherProps {
  /** Where the form submits — the page the reader is already on, so switching
   * branches keeps them on the same view rather than bouncing them to the root. */
  action: string;
  /** Branch names to offer. Empty renders nothing at all: a select with no
   * options is worse than no switcher, and the listing is allowed to fail
   * without taking the page down with it. */
  branchNames: string[];
  /** The branch currently being browsed, preselected in the dropdown. */
  currentRef: string;
}

/**
 * Switches branches with a plain GET form: the browser serialises the `<select>`
 * into `?ref=<name>` and navigates, so no client-side JavaScript is involved —
 * which is the house rule for this UI (AGENTS.md), not a preference.
 *
 * A GET form replaces the query string wholesale, which is exactly right here:
 * `ref` is the only parameter these views read, so nothing is silently dropped.
 */
export const BranchSwitcher: FC<BranchSwitcherProps> = ({ action, branchNames, currentRef }) => {
  if (branchNames.length === 0) return <></>;

  // The current ref can be missing from the listing when it was truncated at
  // MAX_BRANCHES; showing the dropdown with nothing selected would misreport
  // which branch is on screen, so it is added back rather than dropped.
  const options = branchNames.includes(currentRef) ? branchNames : [currentRef, ...branchNames];

  return (
    <form class="branch-switcher" method="get" action={action} style="display:inline;">
      <label for="branch-switcher-ref" style="margin-right:0.35rem;">
        Branch
      </label>
      <select id="branch-switcher-ref" name="ref">
        {options.map((name) => (
          <option key={name} value={name} selected={name === currentRef}>
            {name}
          </option>
        ))}
      </select>
      <button type="submit" class="btn">
        Switch
      </button>
    </form>
  );
};

interface BranchesProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
  };
  branches: RepoBranchEntry[];
  /** The project's default branch. Marked in the listing because every
   * operation that does not name a ref resolves to it. */
  defaultBranch: string;
  /** True when the remote advertised more branches than the listing cap and the
   * list was cut — surfaced in place rather than passing a partial list off as
   * complete, the same contract the tags page keeps (#241). */
  truncated: boolean;
  /** Total branches the remote advertised, independent of how many are listed.
   *
   * Required, not optional, for the reason spelled out on `TagsPage`: without
   * it a truncated listing can only describe itself in terms of its own length,
   * which reads as a complete list and defeats the notice. */
  totalBranchCount: number;
  user?: { id: string; email: string; username: string } | null;
}

/**
 * The `/:namespace/:slug/branches` page: every branch the remote advertises,
 * its tip, and a link that browses it.
 *
 * Reads a listing, never a clone — the cost does not grow with the branch
 * count. A capped listing is labelled as capped rather than presented as the
 * whole set, the same contract the tags page keeps.
 */
export const BranchesPage: FC<BranchesProps> = ({
  project,
  branches,
  defaultBranch,
  truncated,
  totalBranchCount,
  user,
}) => {
  return (
    <Layout title={`Branches — ${project.name}`} user={user}>
      {/* The shared project chrome carries the Branches tab, so the old
          "Back to repo" button is redundant — every section is one click away. */}
      <ProjectHeader project={project} active="branches" />
      <div class="page-header">
        <h1>Branches</h1>
      </div>

      {truncated && (
        <div class="empty-state-hint" style="margin-bottom: 1rem;">
          Showing {branches.length} of {totalBranchCount} branches. The rest were not listed; the
          default branch is always kept.
        </div>
      )}

      {branches.length === 0 ? (
        <div class="empty-state">
          <p>No branches yet.</p>
          <p class="empty-state-hint">
            An empty repository advertises no refs. Push a commit to create the default branch, or
            create a branch through the API.
          </p>
        </div>
      ) : (
        <div class="card">
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>Tip</th>
                  <th>Browse</th>
                </tr>
              </thead>
              <tbody>
                {branches.map((branch) => {
                  const isDefault = branch.name === defaultBranch;
                  return (
                    <tr key={branch.name}>
                      <td class="mono">
                        {branch.name} {isDefault && <span class="badge badge-open">default</span>}
                      </td>
                      <td class="mono">{branch.oid.slice(0, 7)}</td>
                      <td>
                        {/* The default branch keeps its bare URL — see refQuery. */}
                        <a
                          href={`/${project.namespace}/${project.slug}${refQuery(
                            isDefault ? undefined : branch.name,
                          )}`}
                        >
                          Browse
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Layout>
  );
};
