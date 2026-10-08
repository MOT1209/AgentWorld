/**
 * Repository Analyzer -- turns a GitHub repository into a structured
 * Project Health Report. Everything it reports is labelled by provenance:
 *
 *   observed   - read directly from the repo tree / metadata
 *   inferred   - derived from observed facts (e.g. "TypeScript project" from tsconfig)
 *   hypothesis - a guess that a build/test run could confirm or refute
 *
 * This mirrors the failure-evidence discipline of the fix loop: an operator
 * can always tell what the analyzer SAW from what it GUESSED.
 */
import { GithubClient, type GithubRepo, type GithubTreeEntry } from "./github.js";
import { toJson, validationError } from "../../shared/src/index.js";

export interface ProjectHealthReport {
  repoUrl: string;
  repo: GithubRepo | null;
  languages: string[];
  frameworks: string[];
  buildSystem: string[];
  testSetup: string[];
  ci: string[];
  documentation: { readme: boolean; contributing: boolean; license: string | null };
  security: string[];
  technicalDebt: string[];
  observed: string[];
  inferred: string[];
  hypothesis: string[];
  score: number;
}

interface LanguageHint {
  match: RegExp;
  language?: string;
  framework?: string;
  debt?: string;
}

const HINTS: LanguageHint[] = [
  { match: /(^|\/)package\.json$/i, language: "JavaScript/TypeScript", framework: "Node.js" },
  { match: /(^|\/)tsconfig\.json$/i, language: "TypeScript" },
  { match: /(^|\/)next\.config\.[cm]?js$/i, framework: "Next.js" },
  { match: /(^|\/)vite\.config\.[cm]?[jt]s$/i, framework: "Vite" },
  { match: /(^|\/)requirements\.txt$|(^|\/)pyproject\.toml$/i, language: "Python" },
  { match: /(^|\/)manage\.py$/i, framework: "Django" },
  { match: /(^|\/)go\.mod$/i, language: "Go" },
  { match: /(^|\/)Cargo\.toml$/i, language: "Rust" },
  { match: /(^|\/)pom\.xml$|(^|\/)build\.gradle$/i, language: "Java" },
];

const CI_HINTS: Array<{ match: RegExp; label: string }> = [
  { match: /^\.github\/workflows\//i, label: "GitHub Actions" },
  { match: /^\.gitlab-ci\.yml$/i, label: "GitLab CI" },
  { match: /^\.circleci\//i, label: "CircleCI" },
  { match: /^Jenkinsfile$/i, label: "Jenkins" },
];

const SECURITY_HINTS: Array<{ match: RegExp; label: string; good: boolean }> = [
  { match: /^SECURITY\.md$/i, label: "SECURITY.md present", good: true },
  { match: /(^|\/)\.env\.example$/i, label: "env template committed (secrets likely excluded)", good: true },
  { match: /(^|\/)\.env$/i, label: ".env file committed to the repository", good: false },
  { match: /^dependabot\.yml$|^\.github\/dependabot\.yml$/i, label: "Dependabot configured", good: true },
];

export async function analyzeRepository(
  repoUrl: string,
  client: GithubClient,
): Promise<ProjectHealthReport> {
  const { owner, repo } = GithubClient.parseRepoUrl(repoUrl);
  const meta = await client.getRepository(owner, repo);
  if (meta.archived) throw validationError("Repository is archived and cannot enter the factory");
  const tree = await client.getTree(owner, repo, meta.defaultBranch);

  const observed: string[] = [];
  const inferred: string[] = [];
  const hypothesis: string[] = [];

  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const buildSystem = new Set<string>();
  const testSetup = new Set<string>();
  const ci = new Set<string>();
  const security: string[] = [];
  const debt: string[] = [];

  const paths = tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);

  for (const hint of HINTS) {
    const hit = paths.find((path) => hint.match.test(path));
    if (hit !== undefined) {
      if (hint.language !== undefined) languages.add(hint.language);
      if (hint.framework !== undefined) frameworks.add(hint.framework);
    }
  }

  if (paths.includes("package.json")) {
    observed.push("package.json present at repository root");
    buildSystem.add("npm/yarn/pnpm (package.json)");
    hypothesis.push("package-lock.json or yarn.lock missing means installs are not pinned");
  }
  if (paths.some((path) => /(^|\/)(vitest|jest)\.config\.[cm]?[jt]s$/i.test(path))) {
    testSetup.add("unit tests (vitest/jest config)");
  }
  if (paths.some((path) => /(^|\/)playwright\.config\.[cm]?[jt]s$/i.test(path))) {
    testSetup.add("E2E tests (Playwright)");
  }
  if (paths.some((path) => /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i.test(path))) {
    buildSystem.add("Docker");
  }
  if (paths.some((path) => /(^|\/)Makefile$/i.test(path))) {
    buildSystem.add("Make");
  }

  for (const entry of CI_HINTS) {
    if (paths.some((path) => entry.match.test(path))) ci.add(entry.label);
  }
  for (const entry of SECURITY_HINTS) {
    const hit = paths.find((path) => entry.match.test(path));
    if (hit !== undefined) {
      security.push(entry.label);
      if (!entry.good) debt.push(entry.label);
    }
  }

  const readme = paths.some((path) => /^readme(\.md|\.rst)?$/i.test(path));
  const contributing = paths.some((path) => /^contributing(\.md)?$/i.test(path));
  let license: string | null = null;
  const licensePath = paths.find((path) => /^licen[cs]e(\.md|\.txt)?$/i.test(path));
  if (licensePath !== undefined) {
    license = (licensePath.match(/licen[cs]e[-_]?(.*)/i)?.[1] ?? "").trim() || "present";
  }

  if (!readme) debt.push("No README at the repository root");
  if (ci.size === 0) debt.push("No CI configuration detected");
  if (testSetup.size === 0) debt.push("No test configuration detected");

  if (meta.language !== null) {
    languages.add(meta.language);
    observed.push(`GitHub reports primary language: ${meta.language}`);
  }
  observed.push(`Repository tree contains ${tree.length} tracked entries`);

  inferred.push(
    languages.size > 0
      ? `Project languages inferred from manifests: ${[...languages].join(", ")}`
      : "No recognizable language manifests found",
  );
  if (frameworks.size > 0) inferred.push(`Frameworks inferred: ${[...frameworks].join(", ")}`);

  const score = Math.max(
    0,
    Math.min(
      100,
      40 +
        (readme ? 10 : 0) +
        (license !== null ? 5 : 0) +
        (ci.size > 0 ? 15 : 0) +
        (testSetup.size > 0 ? 20 : 0) +
        (meta.archived ? -50 : 0) -
        debt.length * 5,
    ),
  );

  return {
    repoUrl,
    repo: meta,
    languages: [...languages],
    frameworks: [...frameworks],
    buildSystem: [...buildSystem],
    testSetup: [...testSetup],
    ci: [...ci],
    documentation: { readme, contributing, license },
    security,
    technicalDebt: debt,
    observed,
    inferred,
    hypothesis,
    score,
  };
}

export function reportToJson(report: ProjectHealthReport): string {
  return toJson(report);
}

export type { GithubRepo, GithubTreeEntry };
