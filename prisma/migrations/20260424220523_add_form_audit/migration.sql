-- CreateTable
CREATE TABLE "FormAuditRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "formsScanned" INTEGER NOT NULL DEFAULT 0,
    "totalForms" INTEGER,
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT,
    "ruleSet" TEXT NOT NULL,
    "bulkArchiveStatus" TEXT,
    "bulkArchiveMinScore" REAL,
    "bulkArchiveTotal" INTEGER,
    "bulkArchivedCount" INTEGER NOT NULL DEFAULT 0,
    "bulkArchiveFailedCount" INTEGER NOT NULL DEFAULT 0,
    "bulkArchiveStartedAt" DATETIME,
    "bulkArchiveCompletedAt" DATETIME,
    "bulkArchiveError" TEXT
);

-- CreateTable
CREATE TABLE "FormFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditRunId" TEXT NOT NULL,
    "hubspotFormId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "formType" TEXT NOT NULL,
    "fieldCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "lastSubmittedAt" DATETIME,
    "submissionsSeen" BOOLEAN NOT NULL DEFAULT false,
    "confidence" REAL NOT NULL,
    "recommendation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonJson" TEXT NOT NULL,
    "decidedAt" DATETIME,
    "errorMessage" TEXT,
    "metadataSnapshot" TEXT NOT NULL,
    CONSTRAINT "FormFinding_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "FormAuditRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SuppressedForm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hubspotFormId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "FormAuditRun_status_startedAt_idx" ON "FormAuditRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "FormFinding_auditRunId_status_idx" ON "FormFinding"("auditRunId", "status");

-- CreateIndex
CREATE INDEX "FormFinding_auditRunId_confidence_idx" ON "FormFinding"("auditRunId", "confidence");

-- CreateIndex
CREATE INDEX "FormFinding_hubspotFormId_idx" ON "FormFinding"("hubspotFormId");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressedForm_hubspotFormId_key" ON "SuppressedForm"("hubspotFormId");
