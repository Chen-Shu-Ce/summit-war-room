import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { generateDocNumber } from "../services/doc-number";
import { AppError } from "../middleware/error-handler";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get(
  "/",
  wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where: Record<string, unknown> = {};
    if (req.query.projectId) where.projectId = req.query.projectId;
    if (req.query.status) where.status = req.query.status;

    const [data, total] = await Promise.all([
      prisma.siteRequest.findMany({
        where,
        include: { legalEntity: true, project: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.siteRequest.count({ where }),
    ]);
    res.json({ data, total, page, pageSize });
  })
);

router.post(
  "/",
  wrap(async (req, res) => {
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    if (idempotencyKey) {
      const existing = await prisma.siteRequest.findUnique({ where: { idempotencyKey } });
      if (existing) {
        res.status(200).json(existing);
        return;
      }
    }

    const { legalEntityId, projectId, title, description, items, totalAmount } = req.body;

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new AppError(404, "Project not found");
    if (project.status !== "ACTIVE") {
      throw new AppError(400, "專案尚未完成預算簽核，無法建立需求單 (需要狀態: ACTIVE，目前: " + project.status + ")");
    }

    const docNumber = await generateDocNumber(legalEntityId, "SR");

    const sr = await prisma.siteRequest.create({
      data: {
        docNumber,
        legalEntityId,
        projectId,
        createdBy: req.user!.id,
        updatedBy: req.user!.id,
        title,
        description: description ?? null,
        items: items ? JSON.stringify(items) : "[]",
        totalAmount: totalAmount ?? 0,
        idempotencyKey: idempotencyKey ?? null,
      },
      include: { legalEntity: true, project: true },
    });
    res.status(201).json(sr);
  })
);

router.get(
  "/:id",
  wrap(async (req, res) => {
    const sr = await prisma.siteRequest.findUnique({
      where: { id: req.params.id },
      include: { legalEntity: true, project: true, purchaseReqs: true },
    });
    if (!sr) throw new AppError(404, "SiteRequest not found");
    res.json(sr);
  })
);

router.put(
  "/:id",
  wrap(async (req, res) => {
    const { rowVersion, title, description, items, totalAmount } = req.body;
    if (rowVersion == null) throw new AppError(400, "rowVersion is required");

    const sr = await prisma.siteRequest.findUnique({ where: { id: req.params.id } });
    if (!sr) throw new AppError(404, "SiteRequest not found");
    if (sr.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be edited");
    if (sr.rowVersion !== rowVersion) throw new AppError(409, "Conflict: stale rowVersion");

    const updated = await prisma.siteRequest.update({
      where: { id: req.params.id },
      data: {
        title: title ?? sr.title,
        description: description !== undefined ? description : sr.description,
        items: items ? JSON.stringify(items) : sr.items,
        totalAmount: totalAmount ?? sr.totalAmount,
        updatedBy: req.user!.id,
        rowVersion: { increment: 1 },
      },
      include: { legalEntity: true, project: true },
    });
    res.json(updated);
  })
);

router.post(
  "/:id/submit",
  wrap(async (req, res) => {
    const sr = await prisma.siteRequest.findUnique({ where: { id: req.params.id } });
    if (!sr) throw new AppError(404, "SiteRequest not found");
    if (sr.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be submitted");

    const [updated] = await prisma.$transaction([
      prisma.siteRequest.update({
        where: { id: sr.id },
        data: { status: "PENDING", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
      }),
      prisma.approval.create({
        data: {
          docType: "SR",
          docId: sr.id,
          action: "SUBMIT",
          actorId: req.user!.id,
          actorName: req.user!.name,
        },
      }),
    ]);
    res.json(updated);
  })
);

router.post(
  "/:id/approve",
  wrap(async (req, res) => {
    const sr = await prisma.siteRequest.findUnique({ where: { id: req.params.id } });
    if (!sr) throw new AppError(404, "SiteRequest not found");
    if (sr.status !== "PENDING") throw new AppError(400, "Only PENDING can be approved");

    const [updated] = await prisma.$transaction([
      prisma.siteRequest.update({
        where: { id: sr.id },
        data: { status: "APPROVED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
      }),
      prisma.approval.create({
        data: {
          docType: "SR",
          docId: sr.id,
          action: "APPROVE",
          comment: req.body.comment ?? null,
          actorId: req.user!.id,
          actorName: req.user!.name,
        },
      }),
    ]);
    res.json(updated);
  })
);

router.post(
  "/:id/convert-pr",
  wrap(async (req, res) => {
    const sr = await prisma.siteRequest.findUnique({ where: { id: req.params.id } });
    if (!sr) throw new AppError(404, "SiteRequest not found");
    if (sr.status !== "APPROVED") throw new AppError(400, "Only APPROVED can be converted to PR");

    const prDocNumber = await generateDocNumber(sr.legalEntityId, "PR");

    const [, pr] = await prisma.$transaction([
      prisma.siteRequest.update({
        where: { id: sr.id },
        data: { status: "CONVERTED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
      }),
      prisma.purchaseRequest.create({
        data: {
          docNumber: prDocNumber,
          sourceId: sr.id,
          legalEntityId: sr.legalEntityId,
          projectId: sr.projectId,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
          title: sr.title,
          description: sr.description,
          items: sr.items,
          totalAmount: sr.totalAmount,
        },
        include: { legalEntity: true, project: true },
      }),
    ]);
    res.status(201).json(pr);
  })
);

export default router;
