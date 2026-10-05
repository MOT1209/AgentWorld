import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api.js";

// Lazily loaded so the heavy three.js dependency (SimulationView) and the
// skills view are only fetched when their tab is first opened.
const SimulationView = lazy(() =>
  import("./SimulationView.js").then((m) => ({ default: m.SimulationView })),
);
const SkillsView = lazy(() =>
  import("./SkillsView.js").then((m) => ({ default: m.SkillsView })),
);
import { ExecutionsView, WorkspacesView } from "./ExecutionView.js";

type Section = "simulation" | "world" | "company" | "agents" | "tasks" | "chat" | "economy" | "approvals" | "activity" | "plans" | "sessions" | "workspaces" | "executions" | "escalations" | "skills";

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: "simulation", label: "Simulation" },
  { key: "world", label: "World" },
  { key: "company", label: "Company" },
  { key: "agents", label: "Agents" },
  { key: "tasks", label: "Tasks" },
  { key: "plans", label: "Plans" },
  { key: "sessions", label: "Sessions" },
  { key: "workspaces", label: "Workspaces" },
  { key: "executions", label: "Executions" },
  { key: "escalations", label: "Escalations" },
  { key: "skills", label: "Skills" },
  { key: "chat", label: "Communication" },
  { key: "economy", label: "Economy" },
  { key: "approvals", label: "Approvals" },
  { key: "activity", label: "Activity" },
];

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

function Panel({ title, error, children }: { title: string; error?: string | null; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {error !== null && error !== undefined && error !== "" && (
        <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>
      )}
      {children}
    </section>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function DataTable({ rows }: { rows: Array<Record<string, unknown>> }): JSX.Element {
  if (rows.length === 0) return <p className="text-sm text-gray-500">No rows.</p>;
  const cols = Object.keys(rows[0] as Record<string, unknown>);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            {cols.map((c) => (
              <th key={c} className="px-2 py-1 font-medium text-gray-600">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {cols.map((c) => (
                <td key={c} className="max-w-xs truncate px-2 py-1">{renderValue(row[c]).slice(0, 120)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
      <Panel title="Conversations" error={error}>
        <div className="flex flex-col gap-1">
          {(data ?? []).map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`rounded border px-2 py-1 text-left text-sm ${activeId === c.id ? "border-black bg-gray-100" : "border-gray-200"}`}
            >
              {c.title} <span className="text-gray-400">({c.kind})</span>
            </button>
          ))}
        </div>
        <button onClick={reload} className="mt-2 text-sm text-blue-600">Refresh</button>
      </Panel>
      <div className="md:col-span-2">
        <Panel title="Timeline — human / agent / system / tools">
          {(detail.data?.messages ?? []).map((m) => (
            <div key={m.id} className={`mb-2 rounded border p-2 ${KIND_STYLES[m.kind] ?? "bg-white border-gray-200"}`}>
              <div className="mb-1 text-xs font-semibold text-gray-500">
                {m.senderType} · {m.kind}
              </div>
              <div className="whitespace-pre-wrap text-sm">{m.content}</div>
            </div>
          ))}
          {activeId !== null && (
            <div className="mt-3 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write as owner…"
                className="flex-1 rounded border px-2 py-1 text-sm"
              />
              <button onClick={send} disabled={sending} className="rounded bg-black px-3 py-1 text-sm text-white">
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
    <Panel title="Approvals" error={error}>
      {(data?.items ?? []).map((a) => (
        <div key={a.id} className="mb-2 flex items-center justify-between rounded border p-2 text-sm">
          <div>
            <div className="font-medium">{a.action} · {a.risk} · {a.status}</div>
            <div className="text-gray-500">{a.reason}</div>
          </div>
          {a.status === "PENDING" && (
            <div className="flex gap-2">
              <button onClick={() => void decide(a.id, "APPROVED")} className="rounded bg-green-600 px-2 py-1 text-white">Approve</button>
              <button onClick={() => void decide(a.id, "REJECTED")} className="rounded bg-red-600 px-2 py-1 text-white">Reject</button>
            </div>
          )}
        </div>
      ))}
      {(data?.items ?? []).length === 0 && <p className="text-sm text-gray-500">No approvals.</p>}
    </Panel>
  );
}

export default function App(): JSX.Element {
  const [token, setTok] = useState<string | null>(getToken());
  const [email, setEmail] = useState("king@kingworld.local");
  const [password, setPassword] = useState("");
  const [section, setSection] = useState<Section>("world");
  const [loginError, setLoginError] = useState<string | null>(null);

  const login = async (): Promise<void> => {
    try {
      const res = await api.login(email, password);
      setToken(res.token);
      setTok(res.token);
      setLoginError(null);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e));
    }
  };

  const logout = (): void => {
    setToken(null);
    setTok(null);
  };

  const world = useFetch<unknown>("/world/snapshot", section === "world" ? token : null);
  const companies = useFetch<unknown[]>("/companies", section === "company" ? token : null);
  const agents = useFetch<unknown[]>("/agents", section === "agents" ? token : null);
  const tasks = useFetch<{ items: unknown[] }>("/tasks", section === "tasks" ? token : null);
  const wallets = useFetch<unknown[]>("/economy/wallets", section === "economy" ? token : null);
  const activity = useFetch<unknown[]>("/logs/activity", section === "activity" ? token : null);
  const plans = useFetch<{ items: unknown[] }>("/plans", section === "plans" ? token : null);
  const sessions = useFetch<{ items: unknown[] }>("/sessions", section === "sessions" ? token : null);
  const escalations = useFetch<{ items: unknown[] }>("/escalations/human", section === "escalations" ? token : null);

  if (token === null) {
    return (
      <div className="mx-auto mt-20 max-w-sm rounded border bg-white p-6 shadow">
        <h1 className="mb-4 text-xl font-bold">King World — Owner Login</h1>
        {loginError !== null && <p className="mb-2 text-sm text-red-600">{loginError}</p>}
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="mb-2 w-full rounded border px-2 py-1 text-sm" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" className="mb-3 w-full rounded border px-2 py-1 text-sm" />
        <button onClick={() => void login()} className="w-full rounded bg-black py-1 text-white">Sign in</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="flex items-center justify-between border-b bg-white px-4 py-2">
        <h1 className="font-bold">King World — Dashboard</h1>
        <button onClick={logout} className="text-sm text-blue-600">Sign out</button>
      </header>
      <nav className="flex flex-wrap gap-1 border-b bg-white px-4 py-2">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`rounded px-3 py-1 text-sm ${section === s.key ? "bg-black text-white" : "bg-gray-100"}`}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <main className="mx-auto max-w-6xl p-4">
        <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        {section === "simulation" && <SimulationView token={token} />}
        {section === "world" && (
          <Panel title="World snapshot" error={world.error}>
            <pre className="overflow-auto text-xs">{JSON.stringify(world.data, null, 2)}</pre>
          </Panel>
        )}
        {section === "company" && (
          <Panel title="Companies" error={companies.error}>
            <DataTable rows={(companies.data ?? []) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        {section === "agents" && (
          <Panel title="Agents" error={agents.error}>
            <DataTable rows={(agents.data ?? []) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        {section === "tasks" && (
          <Panel title="Tasks" error={tasks.error}>
            <DataTable rows={((tasks.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        {section === "plans" && (
          <Panel title="Plans" error={plans.error}>
            <DataTable rows={((plans.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        {section === "sessions" && (
          <Panel title="Sessions" error={sessions.error}>
            <DataTable rows={((sessions.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        {section === "workspaces" && <WorkspacesView />}
        {section === "executions" && <ExecutionsView />}
        {section === "escalations" && (
          <Panel title="Escalations awaiting a human" error={escalations.error}>
            <DataTable rows={((escalations.data?.items ?? []) as unknown[]) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        {section === "skills" && <SkillsView token={token} />}
        {section === "chat" && <ChatView token={token} />}
        {section === "economy" && (
          <Panel title="Wallets" error={wallets.error}>
            <DataTable rows={(wallets.data ?? []) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        {section === "approvals" && <ApprovalsView token={token} />}
        {section === "activity" && (
          <Panel title="Activity" error={activity.error}>
            <DataTable rows={(activity.data ?? []) as Array<Record<string, unknown>>} />
          </Panel>
        )}
        </Suspense>
      </main>
    </div>
  );
}
