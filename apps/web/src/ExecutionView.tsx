import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

interface Job {
  id: string;
  kind: string;
  status: string;
  backendId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  agentId: string | null;
  command: string | null;
  attempts: number;
  maxAttempts: number;
  exitCode: number | null;
  error: string | null;
  errorCategory: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Workspace {
  id: string;
  name: string;
  type: string;
  status: string;
  agentId: string | null;
  path: string;
  updatedAt: string;
}

interface Artifact {
  id: string;
  name: string;
  kind: string;
  path: string;
  sizeBytes: number;
  contentHash: string | null;
  mimeType: string | null;
  executionId: string | null;
  createdAt: string;
}

interface FileEntry {
  name: string;
  type: string;
}

interface Logs {
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
}

const ACTIVE = new Set(["QUEUED", "RUNNING"]);

function badge(status: string): string {
  if (status === "COMPLETED") return "bg-green-100 text-green-800";
  if (status === "FAILED" || status === "TIMEOUT") return "bg-red-100 text-red-800";
  if (status === "RUNNING") return "bg-blue-100 text-blue-800";
  if (status === "CANCELLED") return "bg-gray-200 text-gray-700";
  return "bg-amber-100 text-amber-800";
}

/** Show only the binary of an argv command: arguments may carry task text. */
function commandHead(command: string | null): string {
  if (command === null) return "-";
  try {
    const parsed: unknown = JSON.parse(command);
    if (Array.isArray(parsed)) return String(parsed[0] ?? "-");
    if (parsed !== null && typeof parsed === "object" && "prompt" in parsed) return "<prompt>";
  } catch {
    // fall through
  }
  return "-";
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

function ArtifactTable({ items }: { items: Artifact[] }): JSX.Element {
  if (items.length === 0) return <p className="text-sm text-gray-500">No artifacts.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-gray-600">
          <th className="px-2 py-1">Name</th>
          <th className="px-2 py-1">Kind</th>
          <th className="px-2 py-1">Path</th>
          <th className="px-2 py-1">Size</th>
          <th className="px-2 py-1">SHA-256</th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id} className="border-b">
            <td className="px-2 py-1">{a.name}</td>
            <td className="px-2 py-1">{a.kind}</td>
            <td className="px-2 py-1 font-mono text-xs">{a.path}</td>
            <td className="px-2 py-1">{a.sizeBytes} B</td>
            <td className="px-2 py-1 font-mono text-xs">{a.contentHash?.slice(0, 12) ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ExecutionsView(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const list = usePolled<{ items: Job[] }>("/executions?take=50", 3000);
  const job = (list.data?.items ?? []).find((j) => j.id === selected) ?? null;
  const finished = job !== null && !ACTIVE.has(job.status);
  const logs = usePolled<Logs>(finished ? `/executions/${job.id}/logs` : null, 60_000);
  const artifacts = usePolled<{ items: Artifact[] }>(
    job?.workspaceId ? `/workspaces/${job.workspaceId}/artifacts?executionId=${job.id}` : null,
    5000,
  );

  const cancel = (id: string): void => {
    api
      .post(`/executions/${id}/cancel`)
      .then(() => {
        setMessage("Cancel requested");
        list.reload();
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="space-y-4">
      <Card title="Execution jobs">
        {list.error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{list.error}</p>}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-600">
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Kind</th>
              <th className="px-2 py-1">Backend</th>
              <th className="px-2 py-1">Command</th>
              <th className="px-2 py-1">Attempts</th>
              <th className="px-2 py-1">Created</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((j) => (
              <tr
                key={j.id}
                className={`cursor-pointer border-b hover:bg-gray-50 ${j.id === selected ? "bg-blue-50" : ""}`}
                onClick={() => {
                  setSelected(j.id);
                  setMessage(null);
                }}
              >
                <td className="px-2 py-1"><span className={`rounded px-2 py-0.5 text-xs ${badge(j.status)}`}>{j.status}</span></td>
                <td className="px-2 py-1">{j.kind}</td>
                <td className="px-2 py-1">{j.backendId ?? "-"}</td>
                <td className="px-2 py-1 font-mono text-xs">{commandHead(j.command)}</td>
                <td className="px-2 py-1">{j.attempts}/{j.maxAttempts}</td>
                <td className="px-2 py-1">{new Date(j.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(list.data?.items ?? []).length === 0 && <p className="text-sm text-gray-500">No executions yet.</p>}
      </Card>

      {job !== null && (
        <Card title={`Execution ${job.id.slice(0, 8)}`}>
          <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            <div><dt className="text-gray-500">Status</dt><dd><span className={`rounded px-2 py-0.5 text-xs ${badge(job.status)}`}>{job.status}</span></dd></div>
            <div><dt className="text-gray-500">Backend</dt><dd>{job.backendId ?? "-"}</dd></div>
            <div><dt className="text-gray-500">Exit code</dt><dd>{job.exitCode ?? "-"}</dd></div>
            <div><dt className="text-gray-500">Agent</dt><dd className="font-mono text-xs">{job.agentId ?? "-"}</dd></div>
            <div><dt className="text-gray-500">Task</dt><dd className="font-mono text-xs">{job.taskId ?? "-"}</dd></div>
            <div><dt className="text-gray-500">Session</dt><dd className="font-mono text-xs">{job.sessionId ?? "-"}</dd></div>
            <div><dt className="text-gray-500">Workspace</dt><dd className="font-mono text-xs">{job.workspaceId ?? "-"}</dd></div>
            <div><dt className="text-gray-500">Duration</dt><dd>{job.startedAt && job.finishedAt ? `${new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()} ms` : "-"}</dd></div>
          </dl>

          <ol className="mb-3 text-xs text-gray-600">
            <li>Created {new Date(job.createdAt).toLocaleTimeString()}</li>
            {job.startedAt && <li>Started {new Date(job.startedAt).toLocaleTimeString()}</li>}
            {job.finishedAt && <li>Finished {new Date(job.finishedAt).toLocaleTimeString()}</li>}
          </ol>

          {ACTIVE.has(job.status) && (
            <button className="mb-3 rounded bg-red-600 px-3 py-1 text-sm text-white" onClick={() => cancel(job.id)}>
              Cancel
            </button>
          )}
          {message !== null && <p className="mb-2 text-sm text-gray-700">{message}</p>}
          {job.error !== null && (
            <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
              {job.error}{job.errorCategory !== null ? ` (${job.errorCategory})` : ""}
            </p>
          )}

          {finished && logs.data !== null && (
            <div className="mb-3 space-y-2">
              <h3 className="text-sm font-semibold">Output</h3>
              <pre className="max-h-64 overflow-auto rounded bg-gray-900 p-2 text-xs text-gray-100">{logs.data.stdout || "(empty)"}{logs.data.stdoutTruncated ? "\n… truncated" : ""}</pre>
              {logs.data.stderr !== "" && (
                <>
                  <h3 className="text-sm font-semibold">Errors</h3>
                  <pre className="max-h-48 overflow-auto rounded bg-red-950 p-2 text-xs text-red-100">{logs.data.stderr}{logs.data.stderrTruncated ? "\n… truncated" : ""}</pre>
                </>
              )}
            </div>
          )}

          <h3 className="mb-1 text-sm font-semibold">Artifacts</h3>
          <ArtifactTable items={artifacts.data?.items ?? []} />
        </Card>
      )}
    </div>
  );
}

export function WorkspacesView(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const list = usePolled<{ items: Workspace[] }>("/workspaces?take=50", 5000);
  const workspace = (list.data?.items ?? []).find((w) => w.id === selected) ?? null;
  const files = usePolled<{ files: { path: string; entries: FileEntry[] } }>(
    workspace !== null ? `/workspaces/${workspace.id}/files` : null,
    10_000,
  );
  const artifacts = usePolled<{ items: Artifact[] }>(
    workspace !== null ? `/workspaces/${workspace.id}/artifacts` : null,
    10_000,
  );
  const active = usePolled<{ items: Job[] }>(
    workspace !== null ? `/executions?workspaceId=${workspace.id}&status=RUNNING` : null,
    3000,
  );

  return (
    <div className="space-y-4">
      <Card title="Workspaces">
        {list.error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{list.error}</p>}
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-600">
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Type</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Owner</th>
              <th className="px-2 py-1">Updated</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((w) => (
              <tr
                key={w.id}
                className={`cursor-pointer border-b hover:bg-gray-50 ${w.id === selected ? "bg-blue-50" : ""}`}
                onClick={() => setSelected(w.id)}
              >
                <td className="px-2 py-1">{w.name}</td>
                <td className="px-2 py-1">{w.type}</td>
                <td className="px-2 py-1">{w.status}</td>
                <td className="px-2 py-1 font-mono text-xs">{w.agentId ?? "shared"}</td>
                <td className="px-2 py-1">{new Date(w.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(list.data?.items ?? []).length === 0 && <p className="text-sm text-gray-500">No workspaces yet.</p>}
      </Card>

      {workspace !== null && (
        <>
          <Card title={`Files in ${workspace.name}`}>
            {files.error !== null && <p className="text-sm text-red-700">{files.error}</p>}
            <ul className="text-sm">
              {(files.data?.files.entries ?? []).map((e) => (
                <li key={e.name} className="font-mono text-xs">{e.type === "DIRECTORY" ? "[dir]" : "[file]"} {e.name}</li>
              ))}
            </ul>
            {(files.data?.files.entries ?? []).length === 0 && <p className="text-sm text-gray-500">Empty.</p>}
          </Card>
          <Card title="Active executions">
            {(active.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-gray-500">Nothing running.</p>
            ) : (
              <ul className="text-sm">
                {(active.data?.items ?? []).map((j) => (
                  <li key={j.id}>{j.kind} · {commandHead(j.command)} · {j.status}</li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Artifacts">
            <ArtifactTable items={artifacts.data?.items ?? []} />
          </Card>
        </>
      )}
    </div>
  );
}
