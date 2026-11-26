import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { AppError } from "../middleware/error-handler";
import { generateDocNumber } from "../services/doc-number";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

const INCLUDE = { project: true, legalEntity: true };

// GET / — paginated list
router.get("/", wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const where: Record<string, string> = {};
  if (req.query.projectId) where.projectId = req.query.projectId as string;
  if (req.query.status) where.status = req.query.status as string;

  const [data, total] = await Promise.all([
    prisma.subcontractPlan.findMany({
      where, include: INCLUDE,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit, take: limit,
    }),
    prisma.subcontractPlan.count({ where }),
  ]);
  res.json({ data, total, page, limit });
}));

// POST / — create
router.post("/", wrap(async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey) {
    const existing = await prisma.subcontractPlan.findUnique({ where: { idempotencyKey } });
    if (existing) { res.status(200).json(existing); return; }
  }

  const { legalEntityId, projectId, title, description, items } = req.body;
  if (!legalEntityId || !projectId || !title) throw new AppError(400, "Missing required fields: legalEntityId, projectId, title");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, "Project not found");
  if (project.status === "DRAFT") throw new AppError(400, "Project must be registered before creating subcontract plan");

  const parsedItems = typeof items === "string" ? JSON.parse(items) : (items || []);
  const totalAmount = parsedItems.reduce((sum: number, it: { estimatedAmount?: number }) => sum + (it.estimatedAmount || 0), 0);

  const docNumber = await generateDocNumber(legalEntityId, "SUBCONTRACT_PLAN");
  const record = await prisma.subcontractPlan.create({
    data: {
      docNumber, legalEntityId, projectId,
      createdBy: req.user!.id, updatedBy: req.user!.id,
      title, description: description || null,
      items: JSON.stringify(parsedItems), totalAmount,
      idempotencyKey: idempotencyKey || null,
    },
    include: INCLUDE,
  });
  res.status(201).json(record);
}));

// GET /:id
router.get("/:id", wrap(async (req, res) => {
  const record = await prisma.subcontractPlan.findUnique({ where: { id: req.params.id }, include: INCLUDE });
  if (!record) throw new AppError(404, "Subcontract plan not found");
  res.json(record);
}));

// PUT /:id — update (DRAFT or REJECTED only)
router.put("/:id", wrap(async (req, res) => {
  const record = await prisma.subcontractPlan.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Subcontract plan not found");
  if (record.status !== "DRAFT" && record.status !== "REJECTED") throw new AppError(400, `Cannot update in status ${record.status}`);

  const { rowVersion, title, description, items } = req.body;
  if (rowVersion !== undefined && rowVersion !== record.rowVersion) throw new AppError(409, "Row version conflict");

  const parsedItems = items ? (typeof items === "string" ? JSON.parse(items) : items) : undefined;
  const totalAmount = parsedItems ? parsedItems.reduce((sum: number, it: { estimatedAmount?: number }) => sum + (it.estimatedAmount || 0), 0) : undefined;

  const updated = await prisma.subcontractPlan.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(parsedItems && { items: JSON.stringify(parsedItems), totalAmount }),
      updatedBy: req.user!.id,
      rowVersion: { increment: 1 },
    },
    include: INCLUDE,
  });
  res.json(updated);
}));

// POST /:id/submit — DRAFT → PENDING
router.post("/:id/submit", wrap(async (req, res) => {
  const record = await prisma.subcontractPlan.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Subcontract plan not found");
  if (record.status !== "DRAFT") throw new AppError(400, `Cannot submit from status ${record.status}`);

  const updated = await prisma.subcontractPlan.update({
    where: { id: req.params.id },
    data: { status: "PENDING", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    include: INCLUDE,
  });
  await prisma.approval.create({
    data: {
      docType: "SUBCONTRACT_PLAN", docId: record.id,
      action: "SUBMIT", actorId: req.user!.id, actorName: req.user!.name,
    },
  });
  res.json(updated);
}));

// POST /:id/approve — PENDING → APPROVED
router.post("/:id/approve", wrap(async (req, res) => {
  const record = await prisma.subcontractPlan.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Subcontract plan not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot approve from status ${record.status}`);

  const updated = await prisma.subcontractPlan.update({
    where: { id: req.params.id },
    data: { status: "APPROVED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    include: INCLUDE,
  });
  await prisma.approval.create({
    data: {
      docType: "SUBCONTRACT_PLAN", docId: record.id,
      action: "APPROVE", comment: req.body.comment || null,
      actorId: req.user!.id, actorName: req.user!.name,
    },
  });
  res.json(updated);
}));

// POST /:id/reject — PENDING → REJECTED
router.post("/:id/reject", wrap(async (req, res) => {
  const record = await prisma.subcontractPlan.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Subcontract plan not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot reject from status ${record.status}`);

  const updated = await prisma.subcontractPlan.update({
    where: { id: req.params.id },
    data: { status: "REJECTED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    include: INCLUDE,
  });
  await prisma.approval.create({
    data: {
      docType: "SUBCONTRACT_PLAN", docId: record.id,
      action: "REJECT", comment: req.body.comment || null,
      actorId: req.user!.id, actorName: req.user!.name,
    },
  });
  res.json(updated);
}));

export default router;
