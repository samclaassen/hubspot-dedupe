-- CreateTable
CREATE TABLE "PropertyAuditRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "objectTypes" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "propertiesScanned" INTEGER NOT NULL DEFAULT 0,
    "totalProperties" INTEGER,
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
CREATE TABLE "PropertyFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditRunId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "propertyName" TEXT NOT NULL,
    "propertyLabel" TEXT NOT NULL,
    "propertyGroupName" TEXT,
    "fieldType" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "populatedCount" INTEGER NOT NULL,
    "recordBase" INTEGER NOT NULL,
    "hasFormula" BOOLEAN NOT NULL DEFAULT false,
    "hubspotDefined" BOOLEAN NOT NULL DEFAULT false,
    "archivable" BOOLEAN NOT NULL DEFAULT true,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "formField" BOOLEAN NOT NULL DEFAULT false,
    "referencedInWorkflows" INTEGER NOT NULL DEFAULT 0,
    "workflowIdsJson" TEXT,
    "lastModifiedAt" DATETIME,
    "confidence" REAL NOT NULL,
    "recommendation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonJson" TEXT NOT NULL,
    "decidedAt" DATETIME,
    "errorMessage" TEXT,
    "metadataSnapshot" TEXT NOT NULL,
    CONSTRAINT "PropertyFinding_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "PropertyAuditRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SuppressedProperty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "objectType" TEXT NOT NULL,
    "propertyName" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ListAuditRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "listsScanned" INTEGER NOT NULL DEFAULT 0,
    "totalLists" INTEGER,
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT,
    "ruleSet" TEXT NOT NULL,
    "bulkDeleteStatus" TEXT,
    "bulkDeleteMinScore" REAL,
    "bulkDeleteTotal" INTEGER,
    "bulkDeletedCount" INTEGER NOT NULL DEFAULT 0,
    "bulkDeleteFailedCount" INTEGER NOT NULL DEFAULT 0,
    "bulkDeleteStartedAt" DATETIME,
    "bulkDeleteCompletedAt" DATETIME,
    "bulkDeleteError" TEXT
);

-- CreateTable
CREATE TABLE "ListFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditRunId" TEXT NOT NULL,
    "hubspotListId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "processingType" TEXT NOT NULL,
    "objectTypeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "filtersUpdatedAt" DATETIME,
    "memberCount" INTEGER NOT NULL,
    "referenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastRecordAddedAt" DATETIME,
    "lastRecordRemovedAt" DATETIME,
    "confidence" REAL NOT NULL,
    "recommendation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasonJson" TEXT NOT NULL,
    "decidedAt" DATETIME,
    "errorMessage" TEXT,
    "metadataSnapshot" TEXT NOT NULL,
    CONSTRAINT "ListFinding_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "ListAuditRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SuppressedList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hubspotListId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PropertyAuditRun_status_startedAt_idx" ON "PropertyAuditRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "PropertyFinding_auditRunId_status_idx" ON "PropertyFinding"("auditRunId", "status");

-- CreateIndex
CREATE INDEX "PropertyFinding_auditRunId_confidence_idx" ON "PropertyFinding"("auditRunId", "confidence");

-- CreateIndex
CREATE INDEX "PropertyFinding_objectType_propertyName_idx" ON "PropertyFinding"("objectType", "propertyName");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressedProperty_objectType_propertyName_key" ON "SuppressedProperty"("objectType", "propertyName");

-- CreateIndex
CREATE INDEX "ListAuditRun_status_startedAt_idx" ON "ListAuditRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "ListFinding_auditRunId_status_idx" ON "ListFinding"("auditRunId", "status");

-- CreateIndex
CREATE INDEX "ListFinding_auditRunId_confidence_idx" ON "ListFinding"("auditRunId", "confidence");

-- CreateIndex
CREATE INDEX "ListFinding_hubspotListId_idx" ON "ListFinding"("hubspotListId");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressedList_hubspotListId_key" ON "SuppressedList"("hubspotListId");
