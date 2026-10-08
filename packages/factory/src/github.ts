/**
 * GitHub client for the Software Factory.
 *
 * Talks to the official REST API v3 with a token from config (or a connector
 * credential). Bounded: every call has a timeout, and error surfaces are
 * trimmed before they reach rows or events. This is the only file that speaks
 * GitHub REST shapes; the pipeline consumes the decoded types below.
 */
import { getConfig } from "../../shared/src/config.js";
import { conflict, validationError } from "../../shared/src/index.js";

const REQUEST_TIMEOUT_MS = 15_000;

export interface GithubClientOptions {
  token?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  language: string | null;
  sizeKb: number;
  stars: number;
  openIssues: number;
  fork: boolean;
  archived: boolean;
}

export interface GithubBranch {
  name: string;
  sha: string;
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree";
  size: number | null;
}

export interface GithubCommitResult {
  sha: string;
  branch: string;
}

export interface GithubPullRequest {
  number: number;
  url: string;
  state: string;
  title: string;
}

export class GithubClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubClientOptions = {}) {
    this.token = options.token ?? getConfig().factory.githubToken;
    this.apiBase = (options.apiBase ?? getConfig().factory.githubApiBase).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.token !== "";
  }

  static parseRepoUrl(url: string): { owner: string; repo: string } {
    const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
    if (match === null) throw validationError("repoUrl must be a GitHub repository URL (https://github.com/owner/repo)");
    return { owner: match[1] as string, repo: match[2] as string };
  }

  private async call<T>(
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.configured) {
      throw conflict("GitHub token is not configured (FACTORY_GITHUB_TOKEN)");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "AgentWorld-Factory/1.0",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw conflict(`GitHub API ${method} ${path} failed with HTTP ${response.status}`);
      }
      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getRepository(owner: string, repo: string): Promise<GithubRepo> {
    const raw = await this.call<{
      full_name: string;
      default_branch: string;
      language: string | null;
      size: number;
      stargazers_count: number;
      open_issues_count: number;
      fork: boolean;
      archived: boolean;
    }>("GET", `/repos/${owner}/${repo}`);
    return {
      fullName: raw.full_name,
      defaultBranch: raw.default_branch,
      language: raw.language,
      sizeKb: raw.size,
      stars: raw.stargazers_count,
      openIssues: raw.open_issues_count,
      fork: raw.fork,
      archived: raw.archived,
    };
  }

  async listBranches(owner: string, repo: string): Promise<GithubBranch[]> {
    const raw = await this.call<Array<{ name: string; commit: { sha: string } }>>(
      "GET",
      `/repos/${owner}/${repo}/branches?per_page=30`,
    );
    return raw.map((entry) => ({ name: entry.name, sha: entry.commit.sha }));
  }

  async getTree(owner: string, repo: string, branch: string): Promise<GithubTreeEntry[]> {
    const raw = await this.call<{ tree: Array<{ path: string; type: string; size?: number }> }>(
      "GET",
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    return raw.tree.slice(0, 500).map((entry) => ({
      path: entry.path,
      type: entry.type === "tree" ? "tree" : "blob",
      size: entry.size ?? null,
    }));
  }

  async createBranch(owner: string, repo: string, fromBranch: string, newBranch: string): Promise<GithubBranch> {
    const source = await this.call<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
    );
    const created = await this.call<{ ref: string; object: { sha: string } }>("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${newBranch}`,
      sha: source.object.sha,
    });
    return { name: newBranch, sha: created.object.sha };
  }

  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string,
  ): Promise<GithubCommitResult> {
    if (files.length === 0) throw validationError("commitFiles requires at least one file");
    const ref = await this.call<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const baseCommit = await this.call<{ tree: { sha: string } }>("GET", `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    const blobs: Array<{ path: string; sha: string }> = [];
    for (const file of files) {
      const blob = await this.call<{ sha: string }>("POST", `/repos/${owner}/${repo}/git/blobs`, {
        content: Buffer.from(file.content, "utf8").toString("base64"),
        encoding: "base64",
      });
      blobs.push({ path: file.path, sha: blob.sha });
    }
    const tree = await this.call<{ sha: string }>("POST", `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: blobs.map((blob) => ({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha })),
    });
    const commit = await this.call<{ sha: string }>("POST", `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [ref.object.sha],
    });
    await this.call("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: commit.sha,
    });
    return { sha: commit.sha, branch };
  }

  async openPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<GithubPullRequest> {
    const raw = await this.call<{ number: number; html_url: string; state: string; title: string }>(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      { title, head, base, body: body.slice(0, 20_000) },
    );
    return { number: raw.number, url: raw.html_url, state: raw.state, title: raw.title };
  }

  async mergePullRequest(owner: string, repo: string, number: number): Promise<{ merged: boolean; sha: string }> {
    const raw = await this.call<{ merged: boolean; sha: string }>(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${number}/merge`,
      { merge_method: "squash" },
    );
    return { merged: raw.merged, sha: raw.sha };
  }
}
