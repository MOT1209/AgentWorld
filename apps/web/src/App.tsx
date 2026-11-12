import { Component, Suspense, lazy, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { api, getToken, setToken } from "./api.js";

// Lazily loaded so the heavy three.js dependency (SimulationView) and the
// skills view are only fetched when their tab is first opened.
const SimulationView = lazy(() =>
  import("./SimulationView.js").then((m) => ({ default: m.SimulationView })),
);
const SkillsView = lazy(() =>
  import("./SkillsView.js").then((m) => ({ default: m.SkillsView })),
);
const PerformanceView = lazy(() =>
  import("./PerformanceView.js").then((m) => ({ default: m.PerformanceView })),
);
import { ExecutionsView, WorkspacesView } from "./ExecutionView.js";
import { FactoryView, TestingView, IntegrationsView } from "./FactoryView.js";

type Section = "simulation" | "world" | "company" | "agents" | "tasks" | "chat" | "economy" | "approvals" | "activity" | "plans" | "sessions" | "workspaces" | "executions" | "escalations" | "skills" | "factory" | "testing" | "integrations" | "performance";

interface SectionMeta {
  key: Section;
  label: string;
  description: string;
}

/** Sidebar groups: what an operator looks for, not how the API is split. */
const NAV_GROUPS: Array<{ title: string; items: SectionMeta[] }> = [
  {
    title: "World",
    items: [
      { key: "simulation", label: "Live city", description: "Watch agents move through the city in real time." },
      { key: "world", label: "World", description: "Clock, cities, districts and places at a glance." },
      { key: "activity", label: "Activity", description: "Everything people and agents did, newest first." },
    ],
  },
  {
    title: "Company",
    items: [
      { key: "company", label: "Companies", description: "The companies you own or can see." },
      { key: "agents", label: "Agents", description: "Who works here, their roles, skills and reputation." },
      { key: "performance", label: "Performance", description: "Evidence-based results per agent and company." },
      { key: "chat", label: "Communication", description: "Talk to agents and follow their conversations." },
      { key: "economy", label: "Economy", description: "Wallets and balances from the ledger." },
    ],
  },
  {
    title: "Work",
    items: [
      { key: "tasks", label: "Tasks", description: "Work items, owners and status." },
      { key: "plans", label: "Plans", description: "Multi-step plans proposed by planners." },
      { key: "approvals", label: "Approvals", description: "Requests waiting for a human decision." },
      { key: "escalations", label: "Escalations", description: "Problems agents could not solve alone." },
      { key: "sessions", label: "Sessions", description: "Agent work sessions and their outcomes." },
      { key: "workspaces", label: "Workspaces", description: "Sandboxed folders where agents do real work." },
      { key: "executions", label: "Executions", description: "Commands run in workspaces and their output." },
    ],
  },
  {
    title: "Platform",
    items: [
      { key: "factory", label: "Software Factory", description: "From a GitHub URL to a reviewed pull request." },
      { key: "testing", label: "Testing", description: "Test runs across every adapter." },
      { key: "integrations", label: "Integrations", description: "AI providers, connectors, webhooks and API keys." },
      { key: "skills", label: "Skills", description: "Installed skills, their trust and usage." },
    ],
  },
];

const SECTIONS: SectionMeta[] = NAV_GROUPS.flatMap((group) => group.items);
const SECTION_STORAGE_KEY = "kw.section";

function storedSection(): Section {
  try {
    const value = localStorage.getItem(SECTION_STORAGE_KEY);
    if (value !== null && SECTIONS.some((s) => s.key === value)) return value as Section;
  } catch {
    // storage unavailable (private mode); fall through to the default
  }
  return "simulation";
}

function rememberSection(section: Section): void {
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, section);
  } catch {
    // best effort only
  }
}

/** Display name from the access token (claims are not secret; never trusted for auth). */
function tokenIdentity(token: string | null): { name: string; email: string; role: string } | null {
  if (token === null) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "")) as Record<string, unknown>;
    return {
      name: typeof payload.name === "string" ? payload.name : "Operator",
      email: typeof payload.email === "string" ? payload.email : "",
      role: typeof payload.role === "string" ? payload.role : "",
    };
  } catch {
    return null;
  }
}

function BrandMark({ size = 32 }: { size?: number }): JSX.Element {
  return <img src="/brand-mark.png" width={size} height={size} alt="" aria-hidden="true" className="shrink-0" />;
}

const KIND_STYLES: Record<string, string> = {
  MESSAGE: "bg-white border-gray-200",
  PLAN: "bg-blue-50 border-blue-300",
  REPORT: "bg-green-50 border-green-300",
  REQUEST: "bg-amber-50 border-amber-300",
  QUESTION: "bg-purple-50 border-purple-300",
  APPROVAL_REQUEST: "bg-red-50 border-red-300",
  TOOL_RESULT: "bg-gray-100 border-gray-300 font-mono text-xs",
  TASK_RESULT: "bg-teal-50 border-teal-300",
  SYSTEM_NOTICE: "bg-yellow-50 border-yellow-300 italic",
};

function useFetch<T>(path: string | null, token: string | null): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (path === null || token === null) return;
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, [path, token, nonce]);
  return { data, error, reload };
}

function Panel({
  title,
  error,
  actions,
  children,
}: {
  title: string;
  error?: string | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-[0_1px_2px_rgba(13,19,16,0.04)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {actions}
      </div>
      {error !== null && error !== undefined && error !== "" && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {children}
    </section>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50"
    >
      Refresh
    </button>
  );
}

function EmptyState({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
      {children}
    </div>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Agents store skills as records (`{name, level, experience, ...}`), not bare
 * strings. Rendering one directly throws "Objects are not valid as a React
 * child" and, with no error boundary, takes the whole dashboard down -- so the
 * shapes are flattened (and de-duplicated, which keeps React keys unique)
 * before they reach the DOM.
 */
function skillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "object" && entry !== null && "name" in entry) {
        const name = (entry as { name: unknown }).name;
        return typeof name === "string" ? name : "";
      }
      return "";
    })
    .filter((name) => name !== "");
  return [...new Set(names)];
}

/**
 * One view throwing must not blank the dashboard: React unmounts the whole
 * tree when a render error escapes, which is how a single bad DTO shape turned
 * into a dead page. This keeps the shell alive and says what failed.
 */
class ViewErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Dashboard view failed to render", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
          <h2 className="mb-1 font-semibold text-red-800">This view failed to render</h2>
          <p className="mb-2 text-red-700">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })} className="text-blue-700 underline">
            Try again
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

/** camelCase / snake_case key → "Sentence case" column heading. */
function humanize(key: string): string {
  const spaced = key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const STATUS_KEYS = /^(status|state|risk|stage|result|priority|role)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function statusTone(value: string): string {
  const v = value.toUpperCase();
  if (/(DONE|COMPLETED|APPROVED|ACTIVE|SUCCEEDED|PASSED|OK|RUNNING|WORKING|DELIVERED|LOW)/.test(v)) return "bg-green-50 text-green-700 ring-green-600/20";
  if (/(PENDING|QUEUED|WAITING|IN_PROGRESS|REVIEW|MEDIUM|DRAFT|PLANNING|TRAVELING)/.test(v)) return "bg-amber-50 text-amber-700 ring-amber-600/20";
  if (/(FAILED|REJECTED|ERROR|BLOCKED|HIGH|CRITICAL|CANCELLED|DEAD|EXPIRED|REVOKED)/.test(v)) return "bg-red-50 text-red-700 ring-red-600/20";
  return "bg-gray-100 text-gray-700 ring-gray-500/20";
}

function Cell({ column, value }: { column: string; value: unknown }): JSX.Element {
  if (value === null || value === undefined || value === "") return <span className="text-gray-300">—</span>;
  if (typeof value === "boolean") return <span className={value ? "text-green-700" : "text-gray-400"}>{value ? "Yes" : "No"}</span>;
  if (typeof value === "string" && STATUS_KEYS.test(column)) {
    return (
      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${statusTone(value)}`}>
        {value.replace(/_/g, " ")}
      </span>
    );
  }
  if (typeof value === "string" && ISO_DATE.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return <span className="whitespace-nowrap text-gray-600" title={value}>{date.toLocaleString()}</span>;
    }
  }
  if (typeof value === "string" && (column === "id" || /Id$/.test(column))) {
    return <span className="font-mono text-[11px] text-gray-500" title={value}>{value.length > 12 ? `${value.slice(0, 10)}…` : value}</span>;
  }
  const text = renderValue(value);
  return <span title={text.length > 80 ? text : undefined}>{text.slice(0, 120)}</span>;
}

function DataTable({ rows }: { rows: Array<Record<string, unknown>> }): JSX.Element {
  if (rows.length === 0) return <EmptyState>Nothing here yet.</EmptyState>;
  const cols = Object.keys(rows[0] as Record<string, unknown>);
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-y border-gray-200 bg-gray-50">
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {humanize(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50">
              {cols.map((c) => (
                <td key={c} className="max-w-xs truncate px-5 py-2.5 text-gray-800">
                  <Cell column={c} value={row[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface WorldSnapshotView {
  world?: { name?: string; description?: string | null; timeScale?: number };
  simulatedNow?: string;
  phase?: string;
  cities?: Array<{ id: string; name: string; kind?: string; locationCount?: number }>;
  districts?: Array<{ id: string; name: string; kind?: string; cityName?: string; locationCount?: number }>;
  locations?: Array<{ id: string; name: string; kind?: string; occupantCount?: number; capacity?: number | null; districtId?: string | null }>;
  agentCount?: number;
}

function StatTile({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }): JSX.Element {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      {hint !== undefined && <div className="mt-0.5 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

function WorldOverview({ data, error }: { data: unknown; error: string | null }): JSX.Element {
  const snap = (data ?? {}) as WorldSnapshotView;
  const simulated = snap.simulatedNow !== undefined ? new Date(snap.simulatedNow) : null;
  const locations = snap.locations ?? [];
  const occupied = locations.reduce((sum, l) => sum + (l.occupantCount ?? 0), 0);
  return (
    <div className="space-y-5">
      {error !== null && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="World" value={snap.world?.name ?? "—"} hint={snap.world?.timeScale !== undefined ? `${snap.world.timeScale}× time` : undefined} />
        <StatTile
          label="Simulated time"
          value={simulated !== null && !Number.isNaN(simulated.getTime()) ? simulated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
          hint={simulated !== null && !Number.isNaN(simulated.getTime()) ? simulated.toLocaleDateString() : undefined}
        />
        <StatTile label="Phase" value={snap.phase ?? "—"} />
        <StatTile label="Cities" value={snap.cities?.length ?? 0} />
        <StatTile label="Places" value={locations.length} hint={`${occupied} occupied`} />
        <StatTile label="Agents" value={snap.agentCount ?? 0} />
      </div>
      <Panel title="Districts">
        {(snap.districts ?? []).length === 0 ? (
          <EmptyState>No districts yet.</EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(snap.districts ?? []).map((d) => {
              const places = locations.filter((l) => l.districtId === d.id);
              return (
                <div key={d.id} className="rounded-xl border border-gray-200 p-3.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-gray-900">{d.name}</span>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{(d.kind ?? "").replace(/_/g, " ")}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-gray-500">{d.cityName ?? ""} · {places.length} {places.length === 1 ? "place" : "places"}</div>
                  {places.length > 0 && (
                    <ul className="mt-2 space-y-1 text-sm">
                      {places.map((l) => (
                        <li key={l.id} className="flex justify-between gap-2 text-gray-700">
                          <span className="truncate">{l.name}</span>
                          <span className="shrink-0 tabular-nums text-gray-400">
                            {l.occupantCount ?? 0}{l.capacity !== null && l.capacity !== undefined ? `/${l.capacity}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
      <details className="rounded-2xl border border-gray-200 bg-white p-5">
        <summary className="cursor-pointer text-sm font-semibold text-gray-700">Raw snapshot (JSON)</summary>
        <pre className="mt-3 max-h-[480px] overflow-auto rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-700">{JSON.stringify(data, null, 2)}</pre>
      </details>
    </div>
  );
}

function AgentsView({ token }: { token: string }): JSX.Element {
  const { data, error, reload } = useFetch<Array<Record<string, unknown>>>("/agents", token);
  const agents = data ?? [];
  return (
    <Panel title={`Agents (${agents.length})`} error={error} actions={<RefreshButton onClick={reload} />}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => {
          const skills = skillNames(a.skills);
          const rep = typeof a.reputation === "number" ? a.reputation : 50;
          return (
            <div key={String(a.id)} className="rounded-xl border border-gray-200 p-3.5 text-sm transition-colors hover:border-gray-300">
              <div className="flex items-center justify-between">
                <span className="font-medium">{String(a.name)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${rep >= 70 ? "bg-green-100 text-green-800" : rep >= 40 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>
                  rep {rep}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {String(a.roleKey)} · {String(a.title)}
                {a.isActive === false && <span className="ml-1 text-red-600">· inactive</span>}
              </p>
              <p className="mt-1 font-mono text-[11px] text-gray-400">{a.providerId as string}/{String(a.model)}</p>
              {skills.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {skills.slice(0, 6).map((s) => (
                    <span key={s} className="rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">{s}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {agents.length === 0 && <EmptyState>No agents yet.</EmptyState>}
    </Panel>
  );
}

function ChatView({ token }: { token: string }): JSX.Element {
  const { data, error, reload } = useFetch<Array<{ id: string; title: string; kind: string }>>("/conversations", token);
  const [activeId, setActiveId] = useState<string | null>(null);
  const detail = useFetch<{ messages: Array<{ id: string; senderType: string; kind: string; content: string }> }>(
    activeId !== null ? `/conversations/${activeId}` : null,
    token,
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const send = async (): Promise<void> => {
    if (activeId === null || draft.trim() === "") return;
    setSending(true);
    try {
      await api.post(`/conversations/${activeId}/messages`, { content: draft });
      setDraft("");
      detail.reload();
    } catch {
      // surfaced on next reload
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Panel title="Conversations" error={error} actions={<RefreshButton onClick={reload} />}>
        <div className="flex flex-col gap-1">
          {(data ?? []).map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${activeId === c.id ? "border-blue-300 bg-blue-50 text-gray-900" : "border-gray-200 hover:bg-gray-50"}`}
            >
              {c.title} <span className="text-gray-400">({c.kind})</span>
            </button>
          ))}
          {(data ?? []).length === 0 && <EmptyState>No conversations.</EmptyState>}
        </div>
      </Panel>
      <div className="md:col-span-2">
        <Panel title="Timeline — human / agent / system / tools">
          {(detail.data?.messages ?? []).map((m) => (
            <div key={m.id} className={`mb-2 rounded-xl border p-3 ${KIND_STYLES[m.kind] ?? "bg-white border-gray-200"}`}>
              <div className="mb-1 text-xs font-semibold text-gray-500">
                {m.senderType} · {m.kind}
              </div>
              <div className="whitespace-pre-wrap text-sm">{m.content}</div>
            </div>
          ))}
          {activeId === null && <EmptyState>Pick a conversation to read its timeline.</EmptyState>}
          {activeId !== null && (
            <div className="mt-3 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write as owner…"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button onClick={send} disabled={sending} className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink-soft">
                Send
              </button>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function ApprovalsView({ token }: { token: string }): JSX.Element {
  const { data, error, reload } = useFetch<{ items: Array<{ id: string; action: string; risk: string; status: string; reason: string }> }>("/approvals", token);
  const decide = async (id: string, decision: "APPROVED" | "REJECTED"): Promise<void> => {
    await api.post(`/approvals/${id}/decision`, { decision, replay: true });
    reload();
  };
  return (
    <Panel title="Approvals" error={error} actions={<RefreshButton onClick={reload} />}>
      {(data?.items ?? []).map((a) => (
        <div key={a.id} className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-gray-200 p-3 text-sm">
          <div>
            <div className="font-medium">{a.action} · {a.risk} · {a.status}</div>
            <div className="text-gray-500">{a.reason}</div>
          </div>
          {a.status === "PENDING" && (
            <div className="flex gap-2">
              <button onClick={() => void decide(a.id, "APPROVED")} className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700">Approve</button>
              <button onClick={() => void decide(a.id, "REJECTED")} className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">Reject</button>
            </div>
          )}
        </div>
      ))}
      {(data?.items ?? []).length === 0 && <EmptyState>Nothing waiting for approval.</EmptyState>}
    </Panel>
  );
}

function LoginScreen({ onSignedIn }: { onSignedIn: (token: string) => void }): JSX.Element {
  const [email, setEmail] = useState("king@kingworld.local");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await api.login(email, password);
      setToken(res.token);
      setLoginError(null);
      onSignedIn(res.token);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none";
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-ink p-12 text-gray-200 lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <BrandMark size={40} />
          <span className="font-display text-xl font-semibold text-white">AgentWorld</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-4xl font-semibold leading-tight text-white">Run a city of AI companies.</h1>
          <p className="mt-4 text-base leading-relaxed text-gray-400">
            Watch agents work, approve risky actions, and steer every company from one console.
          </p>
        </div>
        <p className="text-xs text-gray-500">Owner access only. Every action is audited.</p>
        <div aria-hidden className="pointer-events-none absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-blue-600/25 blur-3xl" />
      </aside>
      <main className="flex items-center justify-center px-4 py-12">
        <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark size={36} />
            <span className="font-display text-lg font-semibold">AgentWorld</span>
          </div>
          <h2 className="text-2xl font-semibold text-gray-900">Sign in</h2>
          <p className="mt-1 text-sm text-gray-500">Use your owner account to open the console.</p>
          {loginError !== null && (
            <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loginError}</p>
          )}
          <label className="mt-6 block text-xs font-semibold uppercase tracking-wide text-gray-500" htmlFor="login-email">Email</label>
          <input id="login-email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" className={`${field} mt-1.5`} />
          <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-gray-500" htmlFor="login-password">Password</label>
          <input id="login-password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" className={`${field} mt-1.5`} />
          <button type="submit" disabled={busy} className="mt-6 w-full rounded-lg bg-ink py-2.5 text-sm font-semibold text-white hover:bg-ink-soft">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function App(): JSX.Element {
  const [token, setTok] = useState<string | null>(getToken());
  const [section, setSectionState] = useState<Section>(storedSection());

  const setSection = (next: Section): void => {
    setSectionState(next);
    rememberSection(next);
  };

  const logout = (): void => {
    setToken(null);
    setTok(null);
  };

  const world = useFetch<unknown>("/world/snapshot", section === "world" ? token : null);
  const companies = useFetch<unknown[]>("/companies", section === "company" ? token : null);
  const tasks = useFetch<{ items: unknown[] }>("/tasks", section === "tasks" ? token : null);
  const wallets = useFetch<unknown[]>("/economy/wallets", section === "economy" ? token : null);
  const activity = useFetch<unknown[]>("/logs/activity", section === "activity" ? token : null);
  const plans = useFetch<{ items: unknown[] }>("/plans", section === "plans" ? token : null);
  const sessions = useFetch<{ items: unknown[] }>("/sessions", section === "sessions" ? token : null);
  const escalations = useFetch<{ items: unknown[] }>("/escalations/human", section === "escalations" ? token : null);

  if (token === null) return <LoginScreen onSignedIn={setTok} />;

  const identity = tokenIdentity(token);
  const meta = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]!;
  const wide = section === "simulation";

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-ink text-gray-300 md:flex">
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <BrandMark size={34} />
          <div className="leading-tight">
            <div className="font-display text-base font-semibold text-white">AgentWorld</div>
            <div className="text-[11px] text-gray-400">Operator console</div>
          </div>
        </div>
        <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="mt-4">
              <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">{group.title}</div>
              {group.items.map((item) => {
                const active = item.key === section;
                return (
                  <button
                    key={item.key}
                    onClick={() => setSection(item.key)}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex w-full items-center rounded-lg px-3 py-1.5 text-left text-[13px] font-medium transition-colors ${
                      active ? "bg-white/10 text-white" : "text-gray-400 hover:bg-white/5 hover:text-gray-100"
                    }`}
                  >
                    {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-sun" />}
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-3 border-t border-white/10 px-5 py-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
            {(identity?.name ?? identity?.email ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-medium text-white">{identity?.name ?? identity?.email ?? "Signed in"}</div>
            <div className="truncate text-[11px] text-gray-500">{identity?.role ?? identity?.email ?? ""}</div>
          </div>
          <button onClick={logout} className="rounded-md px-2 py-1 text-xs text-gray-400 hover:bg-white/10 hover:text-white">
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-gray-200 bg-ink px-4 py-3 md:hidden">
          <BrandMark size={28} />
          <select
            aria-label="Section"
            value={section}
            onChange={(e) => setSection(e.target.value as Section)}
            className="min-w-0 flex-1 rounded-lg border border-white/15 bg-ink-soft px-2 py-1.5 text-sm text-white"
          >
            {NAV_GROUPS.map((group) => (
              <optgroup key={group.title} label={group.title}>
                {group.items.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button onClick={logout} className="text-xs text-gray-300">Sign out</button>
        </header>

        <main className={`w-full flex-1 px-4 py-6 sm:px-6 ${wide ? "" : "mx-auto max-w-7xl"}`}>
          <div className="mb-5">
            <h1 className="text-2xl font-semibold text-gray-900">{meta.label}</h1>
            <p className="mt-1 text-sm text-gray-500">{meta.description}</p>
          </div>
          {/* key: switching tabs clears a previous view's error. */}
          <ViewErrorBoundary key={section}>
          <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
          {section === "simulation" && <SimulationView token={token} />}
          {section === "world" && <WorldOverview data={world.data} error={world.error} />}
          {section === "company" && (
            <Panel title="Companies" error={companies.error} actions={<RefreshButton onClick={companies.reload} />}>
              <DataTable rows={(companies.data ?? []) as Array<Record<string, unknown>>} />
            </Panel>
          )}
          {section === "agents" && <AgentsView token={token} />}
          {section === "performance" && <PerformanceView />}
          {section === "tasks" && (
            <Panel title="Tasks" error={tasks.error} actions={<RefreshButton onClick={tasks.reload} />}>
              <DataTable rows={((tasks.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
            </Panel>
          )}
          {section === "plans" && (
            <Panel title="Plans" error={plans.error} actions={<RefreshButton onClick={plans.reload} />}>
              <DataTable rows={((plans.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
            </Panel>
          )}
          {section === "sessions" && (
            <Panel title="Sessions" error={sessions.error} actions={<RefreshButton onClick={sessions.reload} />}>
              <DataTable rows={((sessions.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
            </Panel>
          )}
          {section === "workspaces" && <WorkspacesView />}
          {section === "executions" && <ExecutionsView />}
          {section === "factory" && <FactoryView />}
          {section === "testing" && <TestingView />}
          {section === "integrations" && <IntegrationsView />}
          {section === "escalations" && (
            <Panel title="Escalations awaiting a human" error={escalations.error} actions={<RefreshButton onClick={escalations.reload} />}>
              <DataTable rows={((escalations.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
            </Panel>
          )}
          {section === "skills" && <SkillsView token={token} />}
          {section === "chat" && <ChatView token={token} />}
          {section === "economy" && (
            <Panel title="Wallets" error={wallets.error} actions={<RefreshButton onClick={wallets.reload} />}>
              <DataTable rows={(wallets.data ?? []) as Array<Record<string, unknown>>} />
            </Panel>
          )}
          {section === "approvals" && <ApprovalsView token={token} />}
          {section === "activity" && (
            <Panel title="Activity" error={activity.error} actions={<RefreshButton onClick={activity.reload} />}>
              <DataTable rows={(activity.data ?? []) as Array<Record<string, unknown>>} />
            </Panel>
          )}
          </Suspense>
          </ViewErrorBoundary>
        </main>
      </div>
    </div>
  );
}
