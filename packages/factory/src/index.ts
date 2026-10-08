export {
  GithubClient,
  type GithubRepo,
  type GithubBranch,
  type GithubTreeEntry,
  type GithubCommitResult,
  type GithubPullRequest,
  type GithubClientOptions,
} from "./github.js";
export {
  analyzeRepository,
  reportToJson,
  type ProjectHealthReport,
} from "./analyzer.js";
export {
  TEST_ADAPTERS,
  TEST_SUITES,
  runTestSuite,
  settleTestRunFromExecution,
  listTestRuns,
  type TestAdapter,
  type TestSuite,
  type StartTestInput,
} from "./testing.js";
export {
  startFactoryRun,
  advanceFactoryRun,
  approveFactoryRun,
  cancelFactoryRun,
  listFactoryRuns,
  pageLimit,
  STAGE_ORDER,
  type StartFactoryRunInput,
  type PageOptions,
} from "./pipeline.js";
export {
  lifecycleFor,
  getProjectStatus,
  type ProjectLifecycle,
  type ProjectStatus,
} from "./project.js";
export { suggestTeam, type TeamSuggestionInput, type TeamCandidate } from "./team.js";
export { analyzeFailure, createFixTask, type FailureAnalysis } from "./fixloop.js";
export { reviewRun, type ReviewCheck, type ReviewVerdict } from "./review.js";
export {
  DEPLOY_TARGETS,
  deployRun,
  refreshDeployments,
  rollbackDeployment,
  listDeployments,
  type DeployTarget,
  type DeploymentRecord,
  type DeploymentStatus,
  type DeployInput,
} from "./deploy.js";
