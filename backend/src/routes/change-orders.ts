import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
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
    prisma.changeOrder.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { legalEntity: true, project: true },
    }),
    prisma.changeOrder.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.post("/", wrap(async (req, res) => {
  const { legalEntityId, projectId, sourceDocType, sourceDocId, title, reason, items, originalAmount, changeAmount } = req.body;
  const user = req.user!;

  const entity = await prisma.legalEntity.findUniqueOrThrow({ where: { id: legalEntityId } });
  const now = new Date();
  const ym = `${String(now.getFullYear() % 100).padStart(2, "0")}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const count = await prisma.changeOrder.count({ where: { legalEntityId } });
  const docNumber = `${entity.code}CO-${ym}${String(count + 1).padStart(3, "0")}`;

  const newAmount = (originalAmount || 0) + (changeAmount || 0);

  const record = await prisma.changeOrder.create({
    data: {
      docNumber,
      legalEntityId,
      projectId,
      sourceDocType: sourceDocType || null,
      sourceDocId: sourceDocId || null,
      createdBy: user.id,
      updatedBy: user.id,
      title,
      reason: reason || null,
      items: items ? JSON.stringify(items) : "[]",
      originalAmount: originalAmount || 0,
      changeAmount: changeAmount || 0,
      newAmount,
    },
  });
  res.status(201).json(record);
}));

router.get("/:id", wrap(async (req, res) => {
  const record = await prisma.changeOrder.findUnique({
    where: { id: req.params.id },
    include: { legalEntity: true, project: true },
  });
  if (!record) throw new AppError(404, "ChangeOrder not found");
  res.json(record);
}));

router.put("/:id", wrap(async (req, res) => {
  const { rowVersion, title, reason, items, originalAmount, changeAmount } = req.body;
  if (rowVersion == null) throw new AppError(400, "rowVersion is required");

  const current = await prisma.changeOrder.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError(404, "ChangeOrder not found");
  if (current.rowVersion !== rowVersion) {
    throw new AppError(409, `Version conflict: expected ${current.rowVersion}, got ${rowVersion}`);
  }

  const effOriginal = originalAmount !== undefined ? originalAmount : current.originalAmount;
  const effChange = changeAmount !== undefined ? changeAmount : current.changeAmount;

  const updated = await prisma.changeOrder.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title }),
      ...(reason !== undefined && { reason }),
      ...(items !== undefined && { items: JSON.stringify(items) }),
      ...(originalAmount !== undefined && { originalAmount }),
      ...(changeAmount !== undefined && { changeAmount }),
      newAmount: effOriginal + effChange,
      updatedBy: req.user!.id,
      rowVersion: { increment: 1 },
    },
  });
  res.json(updated);
}));

router.post("/:id/submit", wrap(async (req, res) => {
  const record = await prisma.changeOrder.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "ChangeOrder not found");
  if (record.status !== "ESTIMATING") throw new AppError(400, `Cannot submit: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.changeOrder.update({
      where: { id: req.params.id },
      data: { status: "PENDING", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "CHANGE_ORDER",
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
  const record = await prisma.changeOrder.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "ChangeOrder not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot approve: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.changeOrder.update({
      where: { id: req.params.id },
      data: { status: "APPROVED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "CHANGE_ORDER",
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

router.post("/:id/reject", wrap(async (req, res) => {
  const record = await prisma.changeOrder.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "ChangeOrder not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot reject: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.changeOrder.update({
      where: { id: req.params.id },
      data: { status: "REJECTED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "CHANGE_ORDER",
        docId: req.params.id,
        action: "REJECT",
        comment: req.body.comment || null,
        actorId: req.user!.id,
        actorName: req.user!.name,
      },
    }),
  ]);
  res.json(updated);
}));

export default router;
