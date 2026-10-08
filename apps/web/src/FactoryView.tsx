import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

interface RunSummary {
  id: string;
  repoUrl: string;
  stage: string;
  createdAt: string;
}

interface Project {
  factoryRunId: string;
  repoUrl: string;
  lifecycle: string;
  stage: string;
  companyId: string;
  repository: { owner: string | null; repo: string | null; branch: string | null };
  workspaceId: string | null;
  team: Array<{ agentId: string; name: string; roleKey: string }>;
  task: { id: string; title: string; status: string } | null;
  tests: Array<{ id: string; suite: string; adapter: string; name: string; status: string }>;
  review: { passed: boolean | null; failedChecks: string[] };
  pullRequest: { url: string | null; number: number | null; mergedBy: string | null; mergedAt: string | null };
  deployments: Array<{ id: string; target: string; environment: string; status: string; error: string | null }>;
  bounds: { fixAttempts: number; maxFixAttempts: number };
  blocked: boolean;
}

interface TestRun {
  id: string;
  suite: string;
  adapter: string;
  name: string;
  status: string;
  durationMs: number;
  createdAt: string;
}

interface ProviderCatalogEntry {
  vendorId: string;
  displayName: string;
  configured: boolean;
  envHint: string;
  liveProviderId: string | null;
}

interface ConnectorEntry {
  slug: string;
  displayName: string;
  version: string;
  category: string;
  kind: string;
  description: string;
  capabilities: string[];
}

function badge(status: string): string {
  if (status === "COMPLETED" || status === "PASSED" || status === "DEPLOYED" || status === "MERGED") {
    return "bg-green-100 text-green-800";
  }
  if (status === "FAILED" || status === "BLOCKED" || status === "ERROR" || status === "TIMEOUT") {
    return "bg-red-100 text-red-800";
  }
  if (status === "RUNNING" || status === "DEVELOPING" || status === "TESTING" || status === "PR_OPEN") {
    return "bg-blue-100 text-blue-800";
  }
  if (status === "CANCELLED" || status === "ROLLED_BACK") return "bg-gray-200 text-gray-700";
  return "bg-amber-100 text-amber-800";
}

function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function usePolled<T>(path: string | null, intervalMs: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const load = (): void => {
      api
        .get<T>(path)
        .then((res) => {
          if (!cancelled) {
            setData(res.data);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, intervalMs, nonce]);
  return { data, error, reload };
}

function Field({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function FactoryView(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("https://github.com/owner/repo");
  const [companyId, setCompanyId] = useState("");
  const runs = usePolled<RunSummary[]>("/factory/runs?limit=50", 5000);
  const project = usePolled<Project>(selected !== null ? `/factory/runs/${selected}/project` : null, 5000);

  const act = (label: string, path: string, body?: unknown): void => {
    setBusy(label);
    setMessage(null);
    api
      .post(path, body)
      .then(() => {
        setMessage(`${label}: ok`);
        runs.reload();
      })
      .catch((e: unknown) => setMessage(`${label} failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(null));
  };

  const start = (): void => {
    if (companyId.trim() === "") {
      setMessage("Company id is required to start a run");
      return;
    }
    act("Start run", "/factory/runs", { repoUrl, companyId: companyId.trim() });
  };

  const p = project.data;
  const terminal = p !== null && ["MERGED", "DEPLOYED", "FAILED", "CANCELLED", "BLOCKED"].includes(p.lifecycle);

  return (
    <div className="space-y-4">
      <Card title="Start a factory run">
        {message !== null && <p className="mb-2 rounded bg-gray-100 p-2 text-sm">{message}</p>}
        <div className="flex flex-wrap gap-2">
          <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="GitHub URL" className="min-w-64 flex-1 rounded border px-2 py-1 text-sm" />
          <input value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="Company id" className="w-64 rounded border px-2 py-1 text-sm" />
          <button onClick={start} disabled={busy !== null} className="rounded bg-black px-3 py-1 text-sm text-white">Start</button>
        </div>
      </Card>

      <Card title="Factory runs">
        {runs.error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{runs.error}</p>}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-600">
              <th className="px-2 py-1">Stage</th>
              <th className="px-2 py-1">Repository</th>
              <th className="px-2 py-1">Created</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id} className={`cursor-pointer border-b hover:bg-gray-50 ${r.id === selected ? "bg-blue-50" : ""}`} onClick={() => { setSelected(r.id); setMessage(null); }}>
                <td className="px-2 py-1"><span className={`rounded px-2 py-0.5 text-xs ${badge(r.stage)}`}>{r.stage}</span></td>
                <td className="px-2 py-1 font-mono text-xs">{r.repoUrl}</td>
                <td className="px-2 py-1">{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(runs.data ?? []).length === 0 && <p className="text-sm text-gray-500">No runs yet.</p>}
      </Card>

      {p !== null && (
        <Card title={`Run ${p.factoryRunId.slice(0, 8)} — ${p.lifecycle}`}>
          <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            <Field label="Lifecycle" value={<span className={`rounded px-2 py-0.5 text-xs ${badge(p.lifecycle)}`}>{p.lifecycle}</span>} />
            <Field label="Stage" value={p.stage} />
            <Field label="Repository" value={<span className="font-mono text-xs">{p.repository.owner ?? "?"} / {p.repository.repo ?? "?"}</span>} />
            <Field label="Branch" value={<span className="font-mono text-xs">{p.repository.branch ?? "-"}</span>} />
            <Field label="Task" value={p.task !== null ? `${p.task.title} (${p.task.status})` : "-"} />
            <Field label="Team" value={p.team.length > 0 ? p.team.map((m) => `${m.name} (${m.roleKey})`).join(", ") : "no agent assigned"} />
            <Field label="Fix budget" value={`${p.bounds.fixAttempts}/${p.bounds.maxFixAttempts}`} />
            <Field label="Blocked" value={p.blocked ? "yes" : "no"} />
          </dl>

          <h3 className="mb-1 text-sm font-semibold">Tests — which passed, what failed</h3>
          {p.tests.length === 0 ? (
            <p className="mb-3 text-sm text-gray-500">No test evidence yet.</p>
          ) : (
            <table className="mb-3 w-full text-left text-sm">
              <tbody>
                {p.tests.slice(0, 8).map((t) => (
                  <tr key={t.id} className="border-b">
                    <td className="px-2 py-1"><span className={`rounded px-2 py-0.5 text-xs ${badge(t.status)}`}>{t.status}</span></td>
                    <td className="px-2 py-1">{t.suite}</td>
                    <td className="px-2 py-1 font-mono text-xs">{t.name.slice(0, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="mb-1 text-sm font-semibold">Review</h3>
          <p className="mb-3 text-sm">
            {p.review.passed === null ? "No review verdict yet." : p.review.passed ? "Passed." : `Failing: ${p.review.failedChecks.join(", ")}`}
          </p>

          <h3 className="mb-1 text-sm font-semibold">Pull request</h3>
          <p className="mb-3 text-sm">
            {p.pullRequest.url !== null ? (
              <a href={p.pullRequest.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">PR #{p.pullRequest.number}</a>
            ) : "No PR opened yet."}
            {p.pullRequest.mergedBy !== null ? ` Merged by ${p.pullRequest.mergedBy}.` : ""}
          </p>

          <h3 className="mb-1 text-sm font-semibold">Deployments</h3>
          {p.deployments.length === 0 ? (
            <p className="mb-3 text-sm text-gray-500">No deployments recorded.</p>
          ) : (
            <ul className="mb-3 text-sm">
              {p.deployments.map((d) => (
                <li key={d.id}>{d.target} / {d.environment} — <span className={`rounded px-2 py-0.5 text-xs ${badge(d.status)}`}>{d.status}</span>{d.error !== null ? ` — ${d.error}` : ""}</li>
              ))}
            </ul>
          )}

          {!terminal && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => act("Advance", `/factory/runs/${p.factoryRunId}/advance`)} disabled={busy !== null} className="rounded bg-black px-3 py-1 text-sm text-white">Advance one stage</button>
              <button onClick={() => act("Review", `/factory/runs/${p.factoryRunId}/review`)} disabled={busy !== null} className="rounded bg-gray-800 px-3 py-1 text-sm text-white">Run review gate</button>
              <button onClick={() => act("Suggest team", `/factory/runs/${p.factoryRunId}/team`, { taskType: "IMPLEMENTATION", limit: 3 })} disabled={busy !== null} className="rounded bg-gray-800 px-3 py-1 text-sm text-white">Suggest team</button>
              <button onClick={() => act("Approve & merge", `/factory/runs/${p.factoryRunId}/approve`)} disabled={busy !== null} className="rounded bg-green-700 px-3 py-1 text-sm text-white">Approve & merge</button>
              <button onClick={() => act("Cancel", `/factory/runs/${p.factoryRunId}/cancel`)} disabled={busy !== null} className="rounded bg-red-600 px-3 py-1 text-sm text-white">Cancel</button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

const QA_SUITES = ["UNIT", "INTEGRATION", "E2E", "BROWSER", "MOBILE", "SECURITY", "PERFORMANCE"] as const;

export function TestingView(): JSX.Element {
  const [suite, setSuite] = useState<string>("SECURITY");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const runs = usePolled<TestRun[]>("/testing/runs?limit=50", 5000);

  const queue = (): void => {
    setMessage(null);
    const body: Record<string, unknown> = { suite };
    if (command.trim() !== "") body.command = command.trim().split(/\s+/);
    if (url.trim() !== "") body.url = url.trim();
    api
      .post("/testing/run", body)
      .then(() => {
        setMessage("Test run queued");
        runs.reload();
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="space-y-4">
      <Card title="Queue a test run">
        {message !== null && <p className="mb-2 rounded bg-gray-100 p-2 text-sm">{message}</p>}
        <div className="flex flex-wrap gap-2">
          <select value={suite} onChange={(e) => setSuite(e.target.value)} className="rounded border px-2 py-1 text-sm">
            {QA_SUITES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command (e.g. npx vitest run)" className="min-w-64 flex-1 rounded border px-2 py-1 text-sm" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="url to probe (optional)" className="w-64 rounded border px-2 py-1 text-sm" />
          <button onClick={queue} className="rounded bg-black px-3 py-1 text-sm text-white">Queue</button>
        </div>
        <p className="mt-2 text-xs text-gray-500">BROWSER/MOBILE without a command record an honest simulated row (never a pass). SECURITY runs platform self-checks. PERFORMANCE measures query latency.</p>
      </Card>
      <Card title="Test runs">
        {runs.error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{runs.error}</p>}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-600">
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Suite</th>
              <th className="px-2 py-1">Adapter</th>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Duration</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((t) => (
              <tr key={t.id} className="border-b">
                <td className="px-2 py-1"><span className={`rounded px-2 py-0.5 text-xs ${badge(t.status)}`}>{t.status}</span></td>
                <td className="px-2 py-1">{t.suite}</td>
                <td className="px-2 py-1">{t.adapter}</td>
                <td className="px-2 py-1 font-mono text-xs">{t.name.slice(0, 80)}</td>
                <td className="px-2 py-1">{t.durationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(runs.data ?? []).length === 0 && <p className="text-sm text-gray-500">No test runs yet.</p>}
      </Card>
    </div>
  );
}

export function IntegrationsView(): JSX.Element {
  const providers = usePolled<{ providers: Array<{ id: string; kind: string; configured: boolean }>; catalog: ProviderCatalogEntry[] }>("/integrations/providers", 30_000);
  const connectors = usePolled<{ connectors: ConnectorEntry[] }>("/integrations/connectors", 30_000);

  return (
    <div className="space-y-4">
      <Card title="AI providers — live and catalog">
        {providers.error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{providers.error}</p>}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-600">
              <th className="px-2 py-1">Vendor</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">How to enable</th>
            </tr>
          </thead>
          <tbody>
            {(providers.data?.catalog ?? []).map((c) => (
              <tr key={c.vendorId} className="border-b">
                <td className="px-2 py-1">{c.displayName}</td>
                <td className="px-2 py-1"><span className={`rounded px-2 py-0.5 text-xs ${c.configured ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"}`}>{c.configured ? "configured" : "unavailable"}</span></td>
                <td className="px-2 py-1 font-mono text-xs">{c.configured ? (c.liveProviderId ?? "live") : c.envHint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Connector marketplace">
        {connectors.error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{connectors.error}</p>}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-600">
              <th className="px-2 py-1">Connector</th>
              <th className="px-2 py-1">Kind</th>
              <th className="px-2 py-1">Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {(connectors.data?.connectors ?? []).map((c) => (
              <tr key={c.slug} className="border-b">
                <td className="px-2 py-1">{c.displayName} <span className="text-gray-400">v{c.version}</span></td>
                <td className="px-2 py-1">{c.kind}</td>
                <td className="px-2 py-1 font-mono text-xs">{c.capabilities.length > 0 ? c.capabilities.join(", ") : "not configured"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
