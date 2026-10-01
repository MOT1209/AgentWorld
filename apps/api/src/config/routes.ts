import type { Express } from "express";
import { authRouter } from "../routes/auth.routes.js";
import { worldRouter } from "../routes/world.routes.js";
import { companyRouter } from "../routes/company.routes.js";
import { agentRouter } from "../routes/agent.routes.js";
import { taskRouter } from "../routes/task.routes.js";
import { conversationRouter } from "../routes/conversation.routes.js";
import { memoryRouter } from "../routes/memory.routes.js";
import { economyRouter } from "../routes/economy.routes.js";
import { approvalRouter } from "../routes/approval.routes.js";
import { toolRouter } from "../routes/tool.routes.js";
import { eventRouter } from "../routes/event.routes.js";

export function registerRoutes(app: Express): void {
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/world", worldRouter);
  app.use("/api/v1/companies", companyRouter);
  app.use("/api/v1/agents", agentRouter);
  app.use("/api/v1/tasks", taskRouter);
  app.use("/api/v1/conversations", conversationRouter);
  app.use("/api/v1/memories", memoryRouter);
  app.use("/api/v1/economy", economyRouter);
  app.use("/api/v1/approvals", approvalRouter);
  app.use("/api/v1/tools", toolRouter);
  app.use("/api/v1/logs", eventRouter);
}
