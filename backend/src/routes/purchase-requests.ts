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
  const where: Record<string, unknown> = {};
  if (req.query.projectId) where.projectId = req.query.projectId;
  if (req.query.status) where.status = req.query.status;

  const [data, total] = await Promise.all([
    prisma.purchaseRequest.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { legalEntity: true, project: true },
    }),
    prisma.purchaseRequest.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.post("/", wrap(async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey) {
    const existing = await prisma.purchaseRequest.findUnique({ where: { idempotencyKey } });
    if (existing) { res.status(200).json(existing); return; }
  }

  const { legalEntityId, projectId, title, description, items, totalAmount, sourceId } = req.body;
  const docNumber = await generateDocNumber(legalEntityId, "PR");

  const pr = await prisma.purchaseRequest.create({
    data: {
      docNumber,
      sourceId: sourceId || null,
      legalEntityId,
      projectId,
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
      title,
      description: description || null,
      items: JSON.stringify(items || []),
      totalAmount: totalAmount || 0,
      idempotencyKey: idempotencyKey || null,
    },
    include: { legalEntity: true, project: true },
  });
  res.status(201).json(pr);
}));

router.get("/:id", wrap(async (req, res) => {
  const pr = await prisma.purchaseRequest.findUnique({
    where: { id: req.params.id },
    include: { legalEntity: true, project: true, sourceSr: true, purchaseOrders: true },
  });
  if (!pr) throw new AppError(404, "PurchaseRequest not found");
  res.json(pr);
}));

router.put("/:id", wrap(async (req, res) => {
  const { rowVersion, title, description, items, totalAmount, vendorName } = req.body;
  if (rowVersion == null) throw new AppError(400, "rowVersion is required");

  const existing = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, "PurchaseRequest not found");
  if (existing.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be updated");
  if (existing.rowVersion !== rowVersion) throw new AppError(409, "Conflict: stale rowVersion");

  const pr = await prisma.purchaseRequest.update({
    where: { id: req.params.id },
    data: {
      title: title ?? existing.title,
      description: description !== undefined ? description : existing.description,
      items: items ? JSON.stringify(items) : existing.items,
      totalAmount: totalAmount ?? existing.totalAmount,
      updatedBy: req.user!.id,
      rowVersion: { increment: 1 },
    },
    include: { legalEntity: true, project: true },
  });
  res.json(pr);
}));

router.post("/:id/submit", wrap(async (req, res) => {
  const pr = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id } });
  if (!pr) throw new AppError(404, "PurchaseRequest not found");
  if (pr.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be submitted");

  const [updated] = await prisma.$transaction([
    prisma.purchaseRequest.update({
      where: { id: pr.id },
      data: { status: "PENDING", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: { docType: "PR", docId: pr.id, action: "SUBMIT", actorId: req.user!.id, actorName: req.user!.name },
    }),
  ]);
  res.json(updated);
}));

router.post("/:id/approve", wrap(async (req, res) => {
  const pr = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id } });
  if (!pr) throw new AppError(404, "PurchaseRequest not found");
  if (pr.status !== "PENDING") throw new AppError(400, "Only PENDING can be approved");

  const [updated] = await prisma.$transaction([
    prisma.purchaseRequest.update({
      where: { id: pr.id },
      data: { status: "APPROVED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "PR", docId: pr.id, action: "APPROVE",
        comment: req.body.comment || null,
        actorId: req.user!.id, actorName: req.user!.name,
      },
    }),
  ]);
  res.json(updated);
}));

router.post("/:id/reject", wrap(async (req, res) => {
  const pr = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id } });
  if (!pr) throw new AppError(404, "PurchaseRequest not found");
  if (pr.status !== "PENDING") throw new AppError(400, "Only PENDING can be rejected");

  const [updated] = await prisma.$transaction([
    prisma.purchaseRequest.update({
      where: { id: pr.id },
      data: { status: "REJECTED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "PR", docId: pr.id, action: "REJECT",
        comment: req.body.comment || null,
        actorId: req.user!.id, actorName: req.user!.name,
      },
    }),
  ]);
  res.json(updated);
}));

router.post("/:id/convert-po", wrap(async (req, res) => {
  const pr = await prisma.purchaseRequest.findUnique({ where: { id: req.params.id } });
  if (!pr) throw new AppError(404, "PurchaseRequest not found");
  if (pr.status !== "APPROVED") throw new AppError(400, "Only APPROVED can be converted to PO");

  const poDocNumber = await generateDocNumber(pr.legalEntityId, "PO");

  const [, po] = await prisma.$transaction([
    prisma.purchaseRequest.update({
      where: { id: pr.id },
      data: { status: "CONVERTED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.purchaseOrder.create({
      data: {
        docNumber: poDocNumber,
        sourceId: pr.id,
        legalEntityId: pr.legalEntityId,
        projectId: pr.projectId,
        createdBy: req.user!.id,
        updatedBy: req.user!.id,
        title: pr.title,
        items: pr.items,
        totalAmount: pr.totalAmount,
      },
      include: { legalEntity: true, project: true },
    }),
  ]);
  res.status(201).json(po);
}));

export default router;
