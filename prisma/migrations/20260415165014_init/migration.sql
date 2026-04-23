-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "objectType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "recordsScanned" INTEGER NOT NULL DEFAULT 0,
    "totalRecords" INTEGER,
    "groupsFound" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT,
    "ruleSet" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "DuplicateGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanRunId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "matchTier" TEXT NOT NULL,
    "matchScore" REAL NOT NULL,
    "matchReasons" TEXT NOT NULL,
    "primaryId" TEXT,
    "status" TEXT NOT NULL,
    "decidedAt" DATETIME,
    "errorMessage" TEXT,
    CONSTRAINT "DuplicateGroup_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "ScanRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "hubspotId" TEXT NOT NULL,
    "propertiesSnapshot" TEXT NOT NULL,
    CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DuplicateGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SuppressedPair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "objectType" TEXT NOT NULL,
    "idA" TEXT NOT NULL,
    "idB" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ScanRun_status_startedAt_idx" ON "ScanRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "DuplicateGroup_scanRunId_status_idx" ON "DuplicateGroup"("scanRunId", "status");

-- CreateIndex
CREATE INDEX "DuplicateGroup_scanRunId_matchTier_idx" ON "DuplicateGroup"("scanRunId", "matchTier");

-- CreateIndex
CREATE INDEX "GroupMember_groupId_idx" ON "GroupMember"("groupId");

-- CreateIndex
CREATE INDEX "GroupMember_hubspotId_idx" ON "GroupMember"("hubspotId");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressedPair_objectType_idA_idB_key" ON "SuppressedPair"("objectType", "idA", "idB");
