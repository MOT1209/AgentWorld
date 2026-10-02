-- Phase 3 workspaces: real work environments, independent of simulation state.
-- See packages/workspace/src/workspace.service.ts and
-- docs/AGENTWORLD_PHASE_3_ARCHITECTURE.md sections 2 and 5.

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "agentId" TEXT,
    "projectId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'PERSONAL',
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "environment" TEXT NOT NULL DEFAULT '{}',
    "workspaceLocationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workspace_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Workspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkspaceMember_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_path_key" ON "Workspace"("path");

-- CreateIndex
CREATE INDEX "Workspace_agentId_idx" ON "Workspace"("agentId");

-- CreateIndex
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");

-- CreateIndex
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");

-- CreateIndex
CREATE INDEX "Workspace_type_idx" ON "Workspace"("type");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_agentId_key" ON "WorkspaceMember"("workspaceId", "agentId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_agentId_idx" ON "WorkspaceMember"("agentId");
