-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ScanRun" (
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
    "ruleSet" TEXT NOT NULL,
    "autoMergeStatus" TEXT,
    "autoMergeTotal" INTEGER,
    "autoMergedCount" INTEGER NOT NULL DEFAULT 0,
    "autoMergeFailedCount" INTEGER NOT NULL DEFAULT 0,
    "autoMergeStartedAt" DATETIME,
    "autoMergeCompletedAt" DATETIME,
    "autoMergeError" TEXT
);
INSERT INTO "new_ScanRun" ("completedAt", "error", "groupsFound", "id", "objectType", "recordsScanned", "ruleSet", "stage", "startedAt", "status", "totalRecords") SELECT "completedAt", "error", "groupsFound", "id", "objectType", "recordsScanned", "ruleSet", "stage", "startedAt", "status", "totalRecords" FROM "ScanRun";
DROP TABLE "ScanRun";
ALTER TABLE "new_ScanRun" RENAME TO "ScanRun";
CREATE INDEX "ScanRun_status_startedAt_idx" ON "ScanRun"("status", "startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
