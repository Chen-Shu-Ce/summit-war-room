-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "legalEntityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "Project_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "DocSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "legalEntityId" TEXT NOT NULL,
    "typeCode" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DocSequence_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docNumber" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rowVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SiteRequest_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SiteRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docNumber" TEXT NOT NULL,
    "sourceId" TEXT,
    "legalEntityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rowVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseRequest_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequest_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SiteRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docNumber" TEXT NOT NULL,
    "sourceId" TEXT,
    "legalEntityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rowVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "title" TEXT NOT NULL,
    "vendorName" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseOrder_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "PurchaseRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docNumber" TEXT NOT NULL,
    "sourceId" TEXT,
    "legalEntityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rowVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "title" TEXT NOT NULL,
    "items" TEXT NOT NULL DEFAULT '[]',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "inspectedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Inspection_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Inspection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Inspection_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "PurchaseOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docNumber" TEXT NOT NULL,
    "sourceId" TEXT,
    "legalEntityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rowVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "title" TEXT NOT NULL,
    "items" TEXT NOT NULL DEFAULT '[]',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentClaim_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentClaim_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentClaim_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Inspection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalEntity_code_key" ON "LegalEntity"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "DocSequence_legalEntityId_typeCode_yearMonth_key" ON "DocSequence"("legalEntityId", "typeCode", "yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "SiteRequest_docNumber_key" ON "SiteRequest"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SiteRequest_idempotencyKey_key" ON "SiteRequest"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_docNumber_key" ON "PurchaseRequest"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_idempotencyKey_key" ON "PurchaseRequest"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_docNumber_key" ON "PurchaseOrder"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_idempotencyKey_key" ON "PurchaseOrder"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_docNumber_key" ON "Inspection"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_idempotencyKey_key" ON "Inspection"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentClaim_docNumber_key" ON "PaymentClaim"("docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentClaim_idempotencyKey_key" ON "PaymentClaim"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Approval_docType_docId_idx" ON "Approval"("docType", "docId");
