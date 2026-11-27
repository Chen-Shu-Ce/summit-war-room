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
    prisma.purchaseOrder.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { legalEntity: true, project: true },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.post("/", wrap(async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey) {
    const existing = await prisma.purchaseOrder.findUnique({ where: { idempotencyKey } });
    if (existing) { res.status(200).json(existing); return; }
  }

  const { legalEntityId, projectId, title, vendorName, items, totalAmount } = req.body;
  const docNumber = await generateDocNumber(legalEntityId, "PO");
  const po = await prisma.purchaseOrder.create({
    data: {
      docNumber,
      legalEntityId,
      projectId,
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
      title,
      vendorName: vendorName || null,
      items: items ? JSON.stringify(items) : "[]",
      totalAmount: totalAmount || 0,
      idempotencyKey: idempotencyKey || null,
    },
  });
  res.status(201).json(po);
}));

router.get("/:id", wrap(async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: { legalEntity: true, project: true, sourcePr: true, inspections: true },
  });
  if (!po) throw new AppError(404, "PurchaseOrder not found");
  res.json(po);
}));

router.put("/:id", wrap(async (req, res) => {
  const { rowVersion, title, vendorName, items, totalAmount, description } = req.body;
  if (rowVersion === undefined) throw new AppError(400, "rowVersion is required");

  const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, "PurchaseOrder not found");
  if (existing.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be edited");
  if (existing.rowVersion !== rowVersion) throw new AppError(409, "Conflict: stale rowVersion");

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data: {
      title: title ?? existing.title,
      vendorName: vendorName !== undefined ? vendorName : existing.vendorName,
      items: items ? JSON.stringify(items) : existing.items,
      totalAmount: totalAmount ?? existing.totalAmount,
      updatedBy: req.user!.id,
      rowVersion: { increment: 1 },
    },
  });
  res.json(updated);
}));

router.post("/:id/submit", wrap(async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
  if (!po) throw new AppError(404, "PurchaseOrder not found");
  if (po.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be submitted");

  const [updated] = await prisma.$transaction([
    prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "PENDING", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "PO",
        docId: po.id,
        action: "SUBMIT",
        actorId: req.user!.id,
        actorName: req.user!.name,
      },
    }),
  ]);
  res.json(updated);
}));

router.post("/:id/approve", wrap(async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
  if (!po) throw new AppError(404, "PurchaseOrder not found");
  if (po.status !== "PENDING") throw new AppError(400, "Only PENDING can be approved");

  const [updated] = await prisma.$transaction([
    prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "APPROVED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "PO",
        docId: po.id,
        action: "APPROVE",
        comment: req.body.comment || null,
        actorId: req.user!.id,
        actorName: req.user!.name,
      },
    }),
  ]);
  res.json(updated);
}));

router.post("/:id/issue", wrap(async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
  if (!po) throw new AppError(404, "PurchaseOrder not found");
  if (po.status !== "APPROVED") throw new AppError(400, "Only APPROVED can be issued");

  const updated = await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { status: "ISSUED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
  });
  res.json(updated);
}));

export default router;
