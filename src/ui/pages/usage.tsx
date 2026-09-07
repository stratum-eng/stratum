import type { FC } from "hono/jsx";
import type { UsageBannerNotice } from "../../billing/usage-banner";
import type { UsageMeterReport, UsageRateReport, UsageReport } from "../../billing/usage-report";
import { meterTitle } from "../../billing/usage-report";
import { formatDate } from "../format";
import { Layout } from "../layout";

interface UsagePageProps {
  user: { id: string; email: string; username: string; displayName?: string | undefined };
  report: UsageReport;
  /** The 80% notice, rendered by the shared layout like it is on every other page. */
  usageNotice?: UsageBannerNotice | null;
}

/**
 * Units per meter. `sandbox_ms_month` counts milliseconds, which is a number
 * nobody can read at the scale an allowance is set on, so it is the one meter
 * whose quantity is reformatted rather than printed.
 */
function formatQuantity(meter: string, quantity: number): string {
  if (meter === "sandbox_ms_month") {
    if (quantity < 1000) return `${Math.round(quantity)} ms`;
    if (quantity < 60_000) return `${(quantity / 1000).toFixed(1)} s`;
    return `${(quantity / 60_000).toFixed(1)} min`;
  }
  return quantity.toLocaleString("en-US");
}

const RATE_TITLE: Record<string, string> = {
  requests_per_minute: "API requests per minute",
  evaluations_per_hour: "Evaluations per hour",
};

/**
 * One meter's row.
 *
 * The three limit shapes are three different sentences, never one bar with a
 * different number in it. An unlimited meter gets no bar at all: a bar implies
 * a ceiling, and drawing an empty one against `-1` is how a self-hoster's page
 * ends up looking broken rather than looking correct.
 */
const MeterRow: FC<{ entry: UsageMeterReport }> = ({ entry }) => {
  const title = meterTitle(entry.meter);
  return (
    <div class="usage-meter">
      <div class="usage-meter-head">
        <span class="usage-meter-name">{title}</span>
        <span class="usage-meter-figure">
          {entry.unlimited ? (
            <>
              {formatQuantity(entry.meter, entry.used)} used —{" "}
              <strong class="usage-unlimited">Unlimited</strong>
            </>
          ) : entry.blocked ? (
            <>
              {formatQuantity(entry.meter, entry.used)} used —{" "}
              <strong class="usage-blocked">Not included in this plan</strong>
            </>
          ) : (
            <>
              {formatQuantity(entry.meter, entry.used)} of{" "}
              {formatQuantity(entry.meter, entry.limit)}{" "}
              <span class="text-muted">({entry.percentUsed}%)</span>
            </>
          )}
        </span>
      </div>

      {entry.percentUsed !== null && (
        <div
          class="progress-bar"
          role="img"
          aria-label={`${title}: ${entry.percentUsed}% of the monthly allowance used`}
        >
          <div class="progress-fill" style={`width:${Math.min(100, entry.percentUsed)}%`} />
        </div>
      )}

      <p class="settings-help">
        {entry.unlimited
          ? "No cap on this meter. Consumption is still recorded, so the figure above is real."
          : entry.blocked
            ? "This plan does not include this meter at all — the first unit is refused."
            : `${formatQuantity(entry.meter, entry.remaining ?? 0)} left this period.`}
        {entry.byok > 0 && (
          <>
            {" "}
            Separately, {formatQuantity(entry.meter, entry.byok)} was spent on your projects' own
            provider keys (BYOK). That is billed to you by your provider and is <strong>not</strong>{" "}
            counted against the allowance above.
          </>
        )}
      </p>
    </div>
  );
};

const RateRow: FC<{ entry: UsageRateReport }> = ({ entry }) => (
  <>
    <dt>{RATE_TITLE[entry.rate] ?? entry.rate}</dt>
    <dd>{entry.unlimited ? "Unlimited" : entry.limit.toLocaleString("en-US")}</dd>
  </>
);

/**
 * `GET /settings/usage` — this account's consumption against its allowances.
 *
 * A page of its own rather than a card on `/settings`, which is one
 * hash-anchored document that `/profile` redirects into. Server-rendered with
 * no script of any kind: the bars are two divs and an inline width.
 *
 * There is deliberately no organization view — this application has no org UI,
 * and PRD §4a makes an allowance follow the person anyway, so the figures here
 * are the ones every limit is actually checked against.
 */
export const UsagePage: FC<UsagePageProps> = ({ user, report, usageNotice }) => (
  <Layout title="Usage" user={user} active="settings" usageNotice={usageNotice}>
    <div class="page-header">
      <h1>Usage</h1>
      <div class="header-actions">
        <a class="btn" href="/settings">
          Back to settings
        </a>
      </div>
    </div>

    <div class="card" id="period">
      <h2>This period</h2>
      <dl class="detail-list">
        <dt>Period</dt>
        <dd>{report.period} (UTC)</dd>
        <dt>Resets</dt>
        <dd>{formatDate(report.resetsAt)}</dd>
        <dt>Plan</dt>
        <dd>{report.plan}</dd>
      </dl>
      <p class="settings-help">
        {report.metered
          ? report.usedSource === "meter"
            ? "An allowance follows your account, not a project: these are the live counters your work is checked against, wherever you run it — your own namespace or an organization's."
            : "An allowance follows your account, not a project. The counters those checks use could not be read just now, so the figures below are the recorded ledger for your account: work done in an organization's namespace is recorded against the organization and is not included here."
          : "This instance is not configured with a billing service, so no allowance is enforced here. The figures below are what has been recorded against your account, and every limit reads as unlimited."}
      </p>
    </div>

    <div class="card" id="meters">
      <h2>Metered consumption</h2>
      {report.meters.map((entry) => (
        <MeterRow key={entry.meter} entry={entry} />
      ))}
    </div>

    <div class="card" id="rates">
      <h2>Rate limits</h2>
      <dl class="detail-list">
        {report.rates.map((entry) => (
          <RateRow key={entry.rate} entry={entry} />
        ))}
      </dl>
      <p class="settings-help">
        Rate limits bound how often something may run rather than how much it spends, so they are
        not consumed over the period and nothing accumulates against them here. Running an evaluator
        on your own provider key does not lift the hourly evaluation ceiling.
      </p>
    </div>
  </Layout>
);
