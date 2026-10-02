/**
 * External skill providers.
 *
 * Adapter architecture: the registry stays central; providers only
 * discover/fetch raw definitions. Normalization + validation happen
 * downstream so no provider can inject a trusted record directly.
 */
import type { SkillDiscoveryQuery, ExternalSkillListing } from "./types.js";
import type { SkillSourceType } from "./sources.js";

export interface RawSkillContent {
  manifest: unknown;
  files: Record<string, string>;
}

export interface SkillProvider {
  readonly id: SkillSourceType;
  discover(query: SkillDiscoveryQuery): Promise<ExternalSkillListing[]>;
  fetchMetadata(externalId: string): Promise<unknown>;
  fetchContent(externalId: string): Promise<RawSkillContent>;
}

export type FetchFn = (url: string, init?: { query?: Record<string, string> }) => Promise<unknown>;

function toListing(raw: unknown, fallbackSourceType: SkillSourceType): ExternalSkillListing | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const externalId =
    typeof obj.externalId === "string"
      ? obj.externalId
      : typeof obj.id === "string"
        ? obj.id
        : typeof obj.slug === "string"
          ? obj.slug
          : null;
  const name = typeof obj.name === "string" ? obj.name : null;
  if (externalId === null || name === null) return null;
  return {
    externalId,
    name: name.slice(0, 200),
    description: typeof obj.description === "string" ? obj.description.slice(0, 5000) : "",
    version: typeof obj.version === "string" ? obj.version.slice(0, 60) : undefined,
    author:
      typeof obj.author === "string"
        ? obj.author
        : typeof obj.publisher === "string"
          ? obj.publisher
          : undefined,
    repository: typeof obj.repository === "string" ? obj.repository : undefined,
    category: typeof obj.category === "string" ? obj.category : undefined,
    source: {
      type: fallbackSourceType,
      identifier: externalId.slice(0, 500),
      ...(typeof obj.url === "string" ? { url: obj.url.slice(0, 2000) } : {}),
      ...(typeof obj.version === "string" ? { version: obj.version.slice(0, 120) } : {}),
    },
  };
}

/** Built-in AgentWorld skills. Data-only; no network. */
export class AgentWorldProvider implements SkillProvider {
  readonly id = "AGENTWORLD" as const;
  private readonly builtin: ExternalSkillListing[];

  constructor(builtin: ExternalSkillListing[] = []) {
    this.builtin = builtin;
  }

  async discover(query: SkillDiscoveryQuery): Promise<ExternalSkillListing[]> {
    const q = `${query.search ?? ""} ${query.keyword ?? ""} ${query.category ?? ""}`.toLowerCase();
    return this.builtin
      .filter((s) => {
        if (query.author !== undefined && (s.author ?? "").toLowerCase() !== query.author.toLowerCase()) return false;
        if (query.category !== undefined && (s.category ?? "").toLowerCase() !== query.category.toLowerCase()) return false;
        if (q.trim() === "") return true;
        return `${s.name} ${s.description} ${s.category ?? ""}`.toLowerCase().includes(q.trim().split(/\s+/)[0] ?? "");
      })
      .slice(0, query.limit);
  }

  async fetchMetadata(externalId: string): Promise<unknown> {
    const found = this.builtin.find((s) => s.externalId === externalId);
    if (found === undefined) throw new Error(`Unknown AgentWorld skill '${externalId}'`);
    return found;
  }

  async fetchContent(externalId: string): Promise<RawSkillContent> {
    const meta = await this.fetchMetadata(externalId);
    return { manifest: meta, files: {} };
  }
}

/** skills.sh adapter. Network is injected so tests never hit the wire. */
export class SkillsShProvider implements SkillProvider {
  readonly id = "SKILLS_SH" as const;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn | null;

  constructor(options: { baseUrl?: string; fetchFn?: FetchFn } = {}) {
    this.baseUrl = (options.baseUrl ?? "https://www.skills.sh").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? null;
  }

  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (this.fetchFn === null) {
      throw new Error(
        `SkillsShProvider has no fetch function configured (would GET ${this.baseUrl}${path}). ` +
          `Discovery requires an explicit network adapter; refusing to guess endpoints.`,
      );
    }
    return this.fetchFn(`${this.baseUrl}${path}`, { query });
  }

  async discover(query: SkillDiscoveryQuery): Promise<ExternalSkillListing[]> {
    const q: Record<string, string> = {};
    const search = (query.search ?? query.keyword ?? "").trim();
    if (search !== "") q.search = search;
    if (query.category !== undefined) q.category = query.category;
    if (query.author !== undefined) q.author = query.author;
    if (query.repository !== undefined) q.repository = query.repository;
    q.limit = String(query.limit);
    const raw = await this.get("/api/skills", q);
    const items = Array.isArray(raw) ? raw : (raw as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    const out: ExternalSkillListing[] = [];
    for (const item of items) {
      const listing = toListing(item, "SKILLS_SH");
      if (listing !== null) out.push(listing);
    }
    return out.slice(0, query.limit);
  }

  async fetchMetadata(externalId: string): Promise<unknown> {
    if (externalId.includes("..") || externalId.includes("/")) {
      throw new Error("Invalid skills.sh identifier");
    }
    return this.get(`/api/skills/${encodeURIComponent(externalId)}`);
  }

  async fetchContent(externalId: string): Promise<RawSkillContent> {
    const meta = await this.fetchMetadata(externalId);
    if (typeof meta === "object" && meta !== null && "manifest" in meta) {
      const m = meta as { manifest?: unknown; files?: unknown };
      const files: Record<string, string> = {};
      if (typeof m.files === "object" && m.files !== null) {
        for (const [k, v] of Object.entries(m.files as Record<string, unknown>)) {
          if (typeof v === "string") files[k.slice(0, 500)] = v.slice(0, 500000);
        }
      }
      return { manifest: m.manifest ?? meta, files };
    }
    return { manifest: meta, files: {} };
  }
}

/** GitHub adapter. Pins to a revision; HEAD is refused without explicit opt-in. */
export class GitHubProvider implements SkillProvider {
  readonly id = "GITHUB" as const;
  private readonly fetchFn: FetchFn | null;

  constructor(options: { fetchFn?: FetchFn } = {}) {
    this.fetchFn = options.fetchFn ?? null;
  }

  static parseIdentifier(identifier: string): { repository: string; path: string; revision: string } {
    // Accepted: "owner/repo[@rev][/path...]"
    const atSplit = identifier.split("@");
    const repoAndPath = (atSplit[0] ?? "").trim();
    const revision = (atSplit[1] ?? "HEAD").trim() || "HEAD";
    const segments = repoAndPath.split("/").filter((s) => s.length > 0);
    if (segments.length < 2) throw new Error(`Invalid GitHub identifier '${identifier}'`);
    const repository = `${segments[0]}/${segments[1]}`;
    const path = segments.slice(2).join("/");
    if (path.includes("..")) throw new Error("GitHub skill path must not contain traversal");
    return { repository, path, revision };
  }

  async discover(query: SkillDiscoveryQuery): Promise<ExternalSkillListing[]> {
    if (this.fetchFn === null) return [];
    const search = (query.search ?? query.keyword ?? "").trim();
    if (search === "" && query.repository === undefined) return [];
    // Minimal code-search passthrough; the injected fetch decides the endpoint.
    const raw = await this.fetchFn("github:search", {
      query: { q: search, repository: query.repository ?? "" },
    });
    const items = Array.isArray(raw) ? raw : [];
    const out: ExternalSkillListing[] = [];
    for (const item of items) {
      const listing = toListing(item, "GITHUB");
      if (listing !== null) out.push(listing);
    }
    return out.slice(0, query.limit);
  }

  async fetchMetadata(externalId: string): Promise<unknown> {
    const parsed = GitHubProvider.parseIdentifier(externalId);
    if (parsed.revision.toUpperCase() === "HEAD") {
      throw new Error(
        `Refusing to fetch GitHub skill '${externalId}' at floating HEAD. Pin a tag/commit (e.g. owner/repo@v1.2.0).`,
      );
    }
    if (this.fetchFn === null) throw new Error("GitHubProvider has no fetch function configured");
    return this.fetchFn(`github:${parsed.repository}@${parsed.revision}:${parsed.path}`, {});
  }

  async fetchContent(externalId: string): Promise<RawSkillContent> {
    const meta = await this.fetchMetadata(externalId);
    return { manifest: meta, files: {} };
  }
}

/** Local development skills under skills/local/<id>/. Still validated. */
export class LocalProvider implements SkillProvider {
  readonly id = "LOCAL" as const;
  private readonly readFile: (path: string) => Promise<string | null>;

  constructor(readFile?: (path: string) => Promise<string | null>) {
    this.readFile = readFile ?? (async () => null);
  }

  static safeDir(externalId: string): string {
    if (externalId.includes("..") || externalId.includes("/") || externalId.includes("\\")) {
      throw new Error("Invalid local skill identifier");
    }
    return `skills/local/${externalId}`;
  }

  async discover(_query: SkillDiscoveryQuery): Promise<ExternalSkillListing[]> {
    return [];
  }

  async fetchMetadata(externalId: string): Promise<unknown> {
    const dir = LocalProvider.safeDir(externalId);
    const raw = await this.readFile(`${dir}/manifest.json`);
    if (raw === null) throw new Error(`Local skill '${externalId}' has no manifest.json`);
    return JSON.parse(raw) as unknown;
  }

  async fetchContent(externalId: string): Promise<RawSkillContent> {
    const manifest = await this.fetchMetadata(externalId);
    const dir = LocalProvider.safeDir(externalId);
    const skillMd = await this.readFile(`${dir}/SKILL.md`);
    const files: Record<string, string> = {};
    if (skillMd !== null) files["SKILL.md"] = skillMd;
    return { manifest, files };
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<SkillSourceType, SkillProvider>();

  register(provider: SkillProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(type: SkillSourceType): SkillProvider {
    const provider = this.providers.get(type);
    if (provider === undefined) throw new Error(`No skill provider registered for source '${type}'`);
    return provider;
  }

  has(type: SkillSourceType): boolean {
    return this.providers.has(type);
  }

  types(): SkillSourceType[] {
    return [...this.providers.keys()];
  }
}
