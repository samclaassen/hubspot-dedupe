-- CreateTable
CREATE TABLE "WorkflowAuditRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "workflowsScanned" INTEGER NOT NULL DEFAULT 0,
    "totalWorkflows" INTEGER,
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT,
    "ruleSet" TEXT NOT NULL,
    "bulkDisableStatus" TEXT,
    "bulkDisableMinScore" REAL,
    "bulkDisableTotal" INTEGER,
    "bulkDisabledCount" INTEGER NOT NULL DEFAULT 0,
    "bulkDisableFailedCount" INTEGER NOT NULL DEFAULT 0,
    "bulkDisableStartedAt" DATETIME,
    "bulkDisableCompletedAt" DATETIME,
    "bulkDisableError" TEXT
);

-- CreateTable
CREATE TABLE "WorkflowFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditRunId" TEXT NOT NULL,
    "hubspotFlowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "flowType" TEXT NOT NULL,
    "objectTypeId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "revisionId" TEXT NOT NULL,
    "description" TEXT,
    "actionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "confidence" REAL NOT NULL,
    "recommendation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonJson" TEXT NOT NULL,
    "decidedAt" DATETIME,
    "errorMessage" TEXT,
    "metadataSnapshot" TEXT NOT NULL,
    CONSTRAINT "WorkflowFinding_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "WorkflowAuditRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SuppressedWorkflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hubspotFlowId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WorkflowAuditRun_status_startedAt_idx" ON "WorkflowAuditRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowFinding_auditRunId_status_idx" ON "WorkflowFinding"("auditRunId", "status");

-- CreateIndex
CREATE INDEX "WorkflowFinding_auditRunId_confidence_idx" ON "WorkflowFinding"("auditRunId", "confidence");

-- CreateIndex
CREATE INDEX "WorkflowFinding_hubspotFlowId_idx" ON "WorkflowFinding"("hubspotFlowId");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressedWorkflow_hubspotFlowId_key" ON "SuppressedWorkflow"("hubspotFlowId");
