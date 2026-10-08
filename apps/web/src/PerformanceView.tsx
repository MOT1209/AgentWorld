/**
 * Performance Center view.
 *
 * Shows the measured track record of an agent: task success, rework, review
 * verdicts, execution outcomes and AI cost -- all straight from the API,
 * nothing computed in the browser. Rates are color-coded so problems surface
 * at a glance; no data shows as "no data", never as 0%.
 */
import { useEffect, useState } from "react";
import { api } from "./api.js";

interface AgentRow {
  id: string;
  name: string;
  roleKey: string;
  reputation: number;
  isActive: boolean;
}

interface PerformanceSummary {
  agentId: string;
  window: string;
  tasks: { total: number; completed: number; failed: number; cancelled: number; successRate: number | null; reworkCount: number; avgDurationMs: number | null };
  reviews: { total: number; approved: number; needsChanges: number; rejected: number; approvalRate: number | null };
  executions: { total: number; completed: number; failed: number; timeout: number; cancelled: number; successRate: number | null };
  aiUsage: { calls: number; errors: number; estimatedCostMinor: number };
}

function rateColor(rate: number | null): string {
  if (rate === null) return "text-gray-400";
  if (rate >= 80) return "text-green-600";
  if (rate >= 50) return "text-amber-600";
  return "text-red-600";
}

function RateBar({ label, rate, detail }: { label: string; rate: number | null; detail: string }): JSX.Element {
  const pct = rate ?? 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className={rateColor(rate)}>{rate === null ? "no data" : `${rate}%`}</span>
      </div>
      <div className="h-2 w-full rounded bg-gray-100">
        <div
          className={`h-2 rounded ${rate === null ? "bg-gray-300" : rate >= 80 ? "bg-green-500" : rate >= 50 ? "bg-amber-500" : "bg-red-500"}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-gray-500">{detail}</p>
    </div>
  );
}

export function PerformanceView(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [agentsErr, setAgentsErr] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [summary, setSummary] = useState<PerformanceSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<AgentRow[]>("/agents")
      .then((res) => {
        if (cancelled) return;
        setAgents(res.data);
        if (res.data.length > 0) setSelected((cur) => cur ?? res.data[0]!.id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setAgentsErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    setSummary(null);
    setSummaryErr(null);
    api
      .get<PerformanceSummary>(`/performance/agents/${selected}`)
      .then((res) => {
        if (!cancelled) setSummary(res.data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setSummaryErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const agent = agents?.find((a) => a.id === selected) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Agents</h2>
        {agentsErr !== null && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{agentsErr}</p>}
        <div className="flex flex-col gap-1">
          {(agents ?? []).map((a) => (
            <button
              key={a.id}
              onClick={() => {
                setSelected(a.id);
                setSummary(null);
                setSummaryErr(null);
              }}
              className={`flex items-center justify-between rounded border px-2 py-1 text-left text-sm ${selected === a.id ? "border-black bg-gray-100" : "border-gray-200"}`}
            >
              <span>{a.name}</span>
              <span className="text-xs text-gray-500">rep {a.reputation}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="lg:col-span-2">
        <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">
            {agent !== null ? `Performance — ${agent.name}` : "Performance"}
          </h2>
          {summaryErr !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{summaryErr}</p>}
          {summary === null ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <RateBar
                label="Task success"
                rate={summary.tasks.successRate}
                detail={`${summary.tasks.completed} completed / ${summary.tasks.failed} failed / ${summary.tasks.cancelled} cancelled · rework ${summary.tasks.reworkCount}`}
              />
              <RateBar
                label="Review approval"
                rate={summary.reviews.approvalRate}
                detail={`${summary.reviews.approved} approved / ${summary.reviews.needsChanges} changes / ${summary.reviews.rejected} rejected`}
              />
              <RateBar
                label="Execution success"
                rate={summary.executions.successRate}
                detail={`${summary.executions.completed} ok / ${summary.executions.failed} failed / ${summary.executions.timeout} timeout`}
              />
              <div className="text-sm">
                <div className="mb-1 font-medium">AI usage</div>
                <p className="text-gray-600">
                  {summary.aiUsage.calls} calls · {summary.aiUsage.errors} errors · cost{" "}
                  {(summary.aiUsage.estimatedCostMinor / 100).toFixed(2)} KW
                </p>
                {summary.tasks.avgDurationMs !== null && (
                  <p className="mt-1 text-xs text-gray-500">
                    Avg task duration: {(summary.tasks.avgDurationMs / 1000).toFixed(1)}s
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
