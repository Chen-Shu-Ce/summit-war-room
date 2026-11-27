import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { AppError } from "../middleware/error-handler";
import { generateDocNumber } from "../services/doc-number";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get(
  "/",
  wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where: Record<string, unknown> = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.legalEntityId) where.legalEntityId = req.query.legalEntityId;

    const [data, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: { legalEntity: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.project.count({ where }),
    ]);
    res.json({ data, total, page, pageSize });
  })
);

router.post(
  "/",
  wrap(async (req, res) => {
    const { legalEntityId, code, name, clientName, location, contractAmount, startDate, endDate, description, managerId } = req.body;
    const docNumber = await generateDocNumber(legalEntityId, "PROJECT");

    const project = await prisma.project.create({
      data: {
        docNumber,
        legalEntityId,
        code,
        name,
        clientName: clientName ?? null,
        location: location ?? null,
        contractAmount: contractAmount ?? 0,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        description: description ?? null,
        managerId: managerId ?? null,
        createdBy: req.user!.id,
        updatedBy: req.user!.id,
      },
      include: { legalEntity: true },
    });
    res.status(201).json(project);
  })
);

router.get(
  "/:id",
  wrap(async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { legalEntity: true, subcontractPlans: true, engineeringBudgets: true },
    });
    if (!project) throw new AppError(404, "Project not found");
    res.json(project);
  })
);

router.put(
  "/:id",
  wrap(async (req, res) => {
    const { rowVersion, code, name, clientName, location, contractAmount, startDate, endDate, description, managerId } = req.body;
    if (rowVersion == null) throw new AppError(400, "rowVersion is required");

    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) throw new AppError(404, "Project not found");
    if (project.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be edited");
    if (project.rowVersion !== rowVersion) throw new AppError(409, "Conflict: stale rowVersion");

    const updated = await prisma.project.update({
      where: { id: req.params.id },
      data: {
        code: code ?? project.code,
        name: name ?? project.name,
        clientName: clientName !== undefined ? clientName : project.clientName,
        location: location !== undefined ? location : project.location,
        contractAmount: contractAmount ?? project.contractAmount,
        startDate: startDate !== undefined ? startDate : project.startDate,
        endDate: endDate !== undefined ? endDate : project.endDate,
        description: description !== undefined ? description : project.description,
        managerId: managerId !== undefined ? managerId : project.managerId,
        updatedBy: req.user!.id,
        rowVersion: { increment: 1 },
      },
      include: { legalEntity: true },
    });
    res.json(updated);
  })
);

router.post(
  "/:id/register",
  wrap(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) throw new AppError(404, "Project not found");
    if (project.status !== "DRAFT") throw new AppError(400, "Only DRAFT can be registered");

    const [updated] = await prisma.$transaction([
      prisma.project.update({
        where: { id: project.id },
        data: { status: "REGISTERED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
      }),
      prisma.approval.create({
        data: {
          docType: "PROJECT",
          docId: project.id,
          action: "REGISTER",
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
  "/:id/complete",
  wrap(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) throw new AppError(404, "Project not found");
    if (project.status !== "ACTIVE") throw new AppError(400, "Only ACTIVE can be completed");

    const [updated] = await prisma.$transaction([
      prisma.project.update({
        where: { id: project.id },
        data: { status: "COMPLETED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
      }),
      prisma.approval.create({
        data: {
          docType: "PROJECT",
          docId: project.id,
          action: "COMPLETE",
          comment: req.body.comment ?? null,
          actorId: req.user!.id,
          actorName: req.user!.name,
        },
      }),
    ]);
    res.json(updated);
  })
);

export default router;
