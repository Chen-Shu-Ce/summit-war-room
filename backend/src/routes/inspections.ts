import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { generateDocNumber } from "../services/doc-number";
import { AppError } from "../middleware/error-handler";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get("/", wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where: Record<string, string> = {};
  if (req.query.projectId) where.projectId = req.query.projectId as string;
  if (req.query.status) where.status = req.query.status as string;

  const [items, total] = await Promise.all([
    prisma.inspection.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { legalEntity: true, project: true },
    }),
    prisma.inspection.count({ where }),
  ]);

  res.json({ data: items, total, page, pageSize });
}));

router.post("/", wrap(async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey) {
    const existing = await prisma.inspection.findUnique({ where: { idempotencyKey } });
    if (existing) { res.status(200).json(existing); return; }
  }

  const { legalEntityId, projectId, sourceId, title, items, totalAmount } = req.body;
  const docNumber = await generateDocNumber(legalEntityId, "INSPECTION");

  const record = await prisma.inspection.create({
    data: {
      docNumber,
      legalEntityId,
      projectId,
      sourceId: sourceId || null,
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
      title,
      items: items ? JSON.stringify(items) : "[]",
      totalAmount: totalAmount || 0,
      idempotencyKey: idempotencyKey || null,
    },
  });

  res.status(201).json(record);
}));

router.get("/:id", wrap(async (req, res) => {
  const record = await prisma.inspection.findUnique({
    where: { id: req.params.id },
    include: { legalEntity: true, project: true, sourcePo: true, paymentClaims: true },
  });
  if (!record) throw new AppError(404, "Inspection not found");
  res.json(record);
}));

router.put("/:id", wrap(async (req, res) => {
  const { rowVersion, title, items, totalAmount } = req.body;
  if (rowVersion === undefined) throw new AppError(400, "rowVersion is required");

  const current = await prisma.inspection.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError(404, "Inspection not found");
  if (current.rowVersion !== rowVersion) throw new AppError(409, "Version conflict — reload and retry");

  const updated = await prisma.inspection.update({
    where: { id: req.params.id },
    data: {
      title: title ?? current.title,
      items: items ? JSON.stringify(items) : current.items,
      totalAmount: totalAmount ?? current.totalAmount,
      updatedBy: req.user!.id,
      rowVersion: { increment: 1 },
    },
  });

  res.json(updated);
}));

router.post("/:id/complete", wrap(async (req, res) => {
  const record = await prisma.inspection.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Inspection not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot complete from status ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.inspection.update({
      where: { id: req.params.id },
      data: {
        status: "COMPLETED",
        inspectedAt: new Date(),
        updatedBy: req.user!.id,
        rowVersion: { increment: 1 },
      },
    }),
    prisma.approval.create({
      data: {
        docType: "INSPECTION",
        docId: req.params.id,
        action: "APPROVE",
        actorId: req.user!.id,
        actorName: req.user!.name,
        comment: req.body.comment || null,
      },
    }),
  ]);

  res.json(updated);
}));

export default router;
