/**
 * Local external-skill catalog.
 *
 * In-memory store with explicit search filters (search/category/author/
 * repository/keyword/compatibility). Persistence is the caller's choice;
 * the API layer keeps one process-wide instance and emits EventLog rows
 * for every mutation so state changes stay auditable.
 */
import type {
  SkillCatalogRecord,
  SkillCompatibility,
  SkillStatus,
  TrustLevel,
} from "./types.js";

export interface CatalogFilter {
  search?: string;
  category?: string;
  author?: string;
  repository?: string;
  keyword?: string;
  compatibility?: string;
  installedOnly?: boolean;
  trust?: TrustLevel;
  status?: SkillStatus;
  limit?: number;
}

export class SkillCatalog {
  private readonly records = new Map<string, SkillCatalogRecord>();

  upsert(record: SkillCatalogRecord): SkillCatalogRecord {
    this.records.set(record.key, record);
    return record;
  }

  get(key: string): SkillCatalogRecord | undefined {
    return this.records.get(key);
  }

  remove(key: string): boolean {
    return this.records.delete(key);
  }

  list(): SkillCatalogRecord[] {
    return [...this.records.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  get size(): number {
    return this.records.size;
  }

  search(filter: CatalogFilter = {}): SkillCatalogRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const q = `${filter.search ?? ""} ${filter.keyword ?? ""}`.trim().toLowerCase();
    return this.list()
      .filter((r) => {
        if (filter.category !== undefined && (r.category ?? "").toLowerCase() !== filter.category.toLowerCase()) return false;
        if (filter.author !== undefined && (r.author ?? "").toLowerCase() !== filter.author.toLowerCase()) return false;
        if (filter.repository !== undefined && (r.repository ?? "").toLowerCase() !== filter.repository.toLowerCase()) return false;
        if (filter.trust !== undefined && r.trust !== filter.trust) return false;
        if (filter.status !== undefined && r.status !== filter.status) return false;
        if (filter.installedOnly === true && !r.installed) return false;
        if (filter.compatibility !== undefined && r.compatibility !== (filter.compatibility as SkillCompatibility)) return false;
        if (q !== "") {
          const hay = `${r.key} ${r.name} ${r.description} ${r.category ?? ""}`.toLowerCase();
          const firstToken = q.split(/\s+/)[0] ?? "";
          if (firstToken !== "" && !hay.includes(firstToken)) return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  markChecked(key: string, at = new Date().toISOString()): void {
    const record = this.records.get(key);
    if (record !== undefined) record.lastChecked = at;
  }
}

export function blankRecord(partial: {
  key: string;
  name: string;
  description: string;
  source: SkillCatalogRecord["source"];
  externalId: string;
  availableVersion?: string;
  author?: string;
  repository?: string;
  category?: string;
}): SkillCatalogRecord {
  return {
    key: partial.key,
    name: partial.name,
    description: partial.description,
    source: partial.source,
    externalId: partial.externalId,
    installedVersion: null,
    availableVersion: partial.availableVersion ?? null,
    author: partial.author ?? null,
    repository: partial.repository ?? null,
    category: partial.category ?? null,
    trust: "UNVERIFIED",
    risk: "MEDIUM",
    status: "DISCOVERED",
    compatibility: "ADAPTABLE",
    compatibilityReason: null,
    installed: false,
    enabled: false,
    manifest: null,
    securityReport: null,
    integrityHash: null,
    grantedPermissions: [],
    deniedPermissions: [],
    versionHistory: [],
    lastChecked: null,
    lastUpdated: null,
  };
}
