import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get("/", wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const where: Record<string, unknown> = {};
  if (req.query.resource) where.resource = req.query.resource as string;
  if (req.query.resourceId) where.resourceId = req.query.resourceId as string;
  if (req.query.actorId) where.actorId = req.query.actorId as string;
  if (req.query.action) where.action = req.query.action as string;

  if (req.query.dateFrom || req.query.dateTo) {
    where.createdAt = {
      ...(req.query.dateFrom && { gte: new Date(req.query.dateFrom as string) }),
      ...(req.query.dateTo && { lte: new Date(req.query.dateTo as string) }),
    };
  }

  const [data, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.get("/resource/:resource/:resourceId", wrap(async (req, res) => {
  const data = await prisma.auditLog.findMany({
    where: {
      resource: req.params.resource,
      resourceId: req.params.resourceId,
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(data);
}));

export default router;
