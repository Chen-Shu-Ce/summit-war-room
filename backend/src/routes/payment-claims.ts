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

  const [data, total] = await Promise.all([
    prisma.paymentClaim.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { legalEntity: true, project: true },
    }),
    prisma.paymentClaim.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.post("/", wrap(async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey) {
    const existing = await prisma.paymentClaim.findUnique({ where: { idempotencyKey } });
    if (existing) { res.status(200).json(existing); return; }
  }

  const { legalEntityId, projectId, sourceId, title, description, items, totalAmount } = req.body;
  const docNumber = await generateDocNumber(legalEntityId, "PAYMENT_CLAIM");
  const user = req.user!;

  const record = await prisma.paymentClaim.create({
    data: {
      docNumber,
      legalEntityId,
      projectId,
      sourceId: sourceId || null,
      createdBy: user.id,
      updatedBy: user.id,
      title,
      items: items ? JSON.stringify(items) : "[]",
      totalAmount: totalAmount || 0,
      idempotencyKey: idempotencyKey || null,
    },
  });
  res.status(201).json(record);
}));

router.get("/:id", wrap(async (req, res) => {
  const record = await prisma.paymentClaim.findUnique({
    where: { id: req.params.id },
    include: { legalEntity: true, project: true, sourceInsp: true },
  });
  if (!record) throw new AppError(404, "PaymentClaim not found");
  res.json(record);
}));

router.put("/:id", wrap(async (req, res) => {
  const { rowVersion, title, description, items, totalAmount } = req.body;
  if (rowVersion == null) throw new AppError(400, "rowVersion is required");

  const current = await prisma.paymentClaim.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError(404, "PaymentClaim not found");
  if (current.rowVersion !== rowVersion) {
    throw new AppError(409, `Version conflict: expected ${current.rowVersion}, got ${rowVersion}`);
  }

  const updated = await prisma.paymentClaim.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(items !== undefined && { items: JSON.stringify(items) }),
      ...(totalAmount !== undefined && { totalAmount }),
      updatedBy: req.user!.id,
      rowVersion: { increment: 1 },
    },
  });
  res.json(updated);
}));

router.post("/:id/submit", wrap(async (req, res) => {
  const record = await prisma.paymentClaim.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "PaymentClaim not found");
  if (record.status !== "DRAFT") throw new AppError(400, `Cannot submit: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.paymentClaim.update({
      where: { id: req.params.id },
      data: { status: "PENDING", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "PAYMENT_CLAIM",
        docId: req.params.id,
        action: "SUBMIT",
        comment: req.body.comment || null,
        actorId: req.user!.id,
        actorName: req.user!.name,
      },
    }),
  ]);
  res.json(updated);
}));

router.post("/:id/approve", wrap(async (req, res) => {
  const record = await prisma.paymentClaim.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "PaymentClaim not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot approve: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.paymentClaim.update({
      where: { id: req.params.id },
      data: { status: "APPROVED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "PAYMENT_CLAIM",
        docId: req.params.id,
        action: "APPROVE",
        comment: req.body.comment || null,
        actorId: req.user!.id,
        actorName: req.user!.name,
      },
    }),
  ]);
  res.json(updated);
}));

export default router;
