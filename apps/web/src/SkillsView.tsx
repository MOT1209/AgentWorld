import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

interface SkillCard {
  key: string;
  name: string;
  description: string;
  author: string | null;
  version: string | null;
  source: string;
  trust: string;
  risk?: string;
  installed?: boolean;
  enabled?: boolean;
  status?: string;
  compatibility?: string;
  category?: string | null;
}

interface DiscoverResponse {
  data: { items: SkillCard[] };
}

interface CatalogResponse {
  data: { items: SkillCard[] };
}

function asCards(value: unknown): SkillCard[] {
  if (typeof value !== "object" || value === null) return [];
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (i): i is SkillCard => typeof i === "object" && i !== null && typeof (i as { key?: unknown }).key === "string",
  );
}

export function SkillsView({ token }: { token: string }): JSX.Element {
  const [search, setSearch] = useState("");
  const [cards, setCards] = useState<SkillCard[]>([]);
  const [catalog, setCatalog] = useState<SkillCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [detailBody, setDetailBody] = useState<string>("");

  void token;

  const reloadCatalog = useCallback(() => {
    api
      .get<CatalogResponse>("/skills/catalog")
      .then((res) => setCatalog(asCards(res)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    reloadCatalog();
  }, [reloadCatalog]);

  const discover = (): void => {
    api
      .get<DiscoverResponse>(`/skills/discover?search=${encodeURIComponent(search)}&limit=25`)
      .then((res) => {
        setCards(asCards(res));
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const openDetail = (key: string): void => {
    setDetail(key);
    api
      .get<unknown>(`/skills/${encodeURIComponent(key)}`)
      .then((res) => setDetailBody(JSON.stringify(res, null, 2)))
      .catch((e: unknown) => setDetailBody(e instanceof Error ? e.message : String(e)));
  };

  const setEnabled = (key: string, enabled: boolean): void => {
    const path = enabled ? `/skills/${encodeURIComponent(key)}/enable` : `/skills/${encodeURIComponent(key)}/disable`;
    api
      .post<unknown>(path, enabled ? {} : { reason: "Disabled from marketplace" })
      .then(() => reloadCatalog())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="grid gap-4">
      <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Skill Marketplace / Directory</h2>
        {error !== null && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="mb-3 flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search: coding, browser, research, frontend, github, testing…'
            className="flex-1 rounded border px-2 py-1 text-sm"
          />
          <button onClick={discover} className="rounded bg-black px-3 py-1 text-sm text-white">
            Discover
          </button>
          <button onClick={reloadCatalog} className="rounded bg-gray-100 px-3 py-1 text-sm">
            Installed
          </button>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {cards.map((c) => (
            <div key={`${c.source}:${c.key}`} className="rounded border p-2 text-sm">
              <div className="font-medium">{c.name}</div>
              <div className="text-gray-500">{c.description.slice(0, 160)}</div>
              <div className="mt-1 text-xs text-gray-500">
                {c.source} · {c.trust}
                {c.version !== null ? ` · v${c.version}` : ""}
                {c.installed === true ? " · installed" : ""}
              </div>
              <button onClick={() => openDetail(c.key)} className="mt-1 text-xs text-blue-600">
                Inspect
              </button>
            </div>
          ))}
          {cards.length === 0 && <p className="text-sm text-gray-500">Search the directory, or review installed skills below.</p>}
        </div>
      </section>

      <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Installed skills</h2>
        {catalog.map((c) => (
          <div key={c.key} className="mb-2 flex items-center justify-between rounded border p-2 text-sm">
            <div>
              <div className="font-medium">
                {c.name} · {c.trust} · {c.risk ?? "?"} · {c.status ?? ""}
              </div>
              <div className="text-gray-500">
                {c.key} · {c.source} · v{c.version ?? "?"}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => openDetail(c.key)} className="rounded bg-gray-100 px-2 py-1 text-xs">
                Detail
              </button>
              {c.enabled === true ? (
                <button onClick={() => setEnabled(c.key, false)} className="rounded bg-amber-600 px-2 py-1 text-xs text-white">
                  Disable
                </button>
              ) : (
                <button onClick={() => setEnabled(c.key, true)} className="rounded bg-green-600 px-2 py-1 text-xs text-white">
                  Enable
                </button>
              )}
            </div>
          </div>
        ))}
        {catalog.length === 0 && <p className="text-sm text-gray-500">No skills installed yet. Install via the API review flow.</p>}
      </section>

      {detail !== null && (
        <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-lg font-semibold">Skill detail — {detail}</h2>
          <pre className="overflow-auto text-xs">{detailBody}</pre>
          <button onClick={() => setDetail(null)} className="mt-2 text-sm text-blue-600">
            Close
          </button>
        </section>
      )}
    </div>
  );
}
