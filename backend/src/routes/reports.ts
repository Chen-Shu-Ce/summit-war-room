import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { AppError } from "../middleware/error-handler";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

async function countByStatus(model: any, where: Record<string, string> = {}) {
  const all = await model.findMany({ where, select: { status: true } });
  const byStatus: Record<string, number> = {};
  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  return { total: all.length, byStatus };
}

async function buildDashboard(projectFilter: Record<string, string>) {
  const [srCount, prCount, poCount, inspectionCount, paymentClaimCount] = await Promise.all([
    countByStatus(prisma.siteRequest, projectFilter),
    countByStatus(prisma.purchaseRequest, projectFilter),
    countByStatus(prisma.purchaseOrder, projectFilter),
    countByStatus(prisma.inspection, projectFilter),
    countByStatus(prisma.paymentClaim, projectFilter),
  ]);

  const poAgg = await prisma.purchaseOrder.aggregate({
    where: projectFilter,
    _sum: { totalAmount: true },
  });
  const paidAgg = await prisma.paymentClaim.aggregate({
    where: { ...projectFilter, status: "APPROVED" },
    _sum: { totalAmount: true },
  });
  const pendingApprovals = await prisma.approval.count({
    where: { action: "SUBMIT" },
  });

  return {
    srCount,
    prCount,
    poCount,
    inspectionCount,
    paymentClaimCount,
    totalPOAmount: poAgg._sum.totalAmount || 0,
    totalPaidAmount: paidAgg._sum.totalAmount || 0,
    pendingApprovals,
  };
}

router.get("/dashboard", wrap(async (req, res) => {
  const filter: Record<string, string> = {};
  if (req.query.projectId) filter.projectId = req.query.projectId as string;
  res.json(await buildDashboard(filter));
}));

router.get("/project/:projectId/summary", wrap(async (req, res) => {
  const { projectId } = req.params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { legalEntity: true },
  });
  if (!project) throw new AppError(404, "Project not found");

  const dashboard = await buildDashboard({ projectId });
  const budgets = await prisma.budget.findMany({ where: { projectId } });

  res.json({ project, ...dashboard, budgets });
}));

router.get("/procurement-progress", wrap(async (req, res) => {
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  const where: Record<string, string> = {};
  if (req.query.projectId) where.projectId = req.query.projectId as string;

  const [pos, payments] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, select: { createdAt: true, totalAmount: true } }),
    prisma.paymentClaim.findMany({ where: { ...where, status: "APPROVED" }, select: { createdAt: true, totalAmount: true } }),
  ]);

  const monthMap: Record<string, { poCount: number; poAmount: number; paymentAmount: number }> = {};
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthMap[key] = { poCount: 0, poAmount: 0, paymentAmount: 0 };
  }

  for (const po of pos) {
    const d = po.createdAt;
    const key = `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (monthMap[key]) {
      monthMap[key].poCount++;
      monthMap[key].poAmount += po.totalAmount;
    }
  }
  for (const pay of payments) {
    const d = pay.createdAt;
    const key = `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (monthMap[key]) {
      monthMap[key].paymentAmount += pay.totalAmount;
    }
  }

  const result = Object.entries(monthMap)
    .map(([month, data]) => ({ month, ...data }))
    .sort((a, b) => a.month.localeCompare(b.month));

  res.json(result);
}));

router.get("/vendor-analysis", wrap(async (req, res) => {
  const where: Record<string, string> = {};
  if (req.query.projectId) where.projectId = req.query.projectId as string;

  const pos = await prisma.purchaseOrder.findMany({
    where,
    select: { vendorName: true, totalAmount: true },
  });

  const vendorMap: Record<string, { poCount: number; totalAmount: number }> = {};
  for (const po of pos) {
    const name = po.vendorName || "(未指定)";
    if (!vendorMap[name]) vendorMap[name] = { poCount: 0, totalAmount: 0 };
    vendorMap[name].poCount++;
    vendorMap[name].totalAmount += po.totalAmount;
  }

  const result = Object.entries(vendorMap)
    .map(([vendorName, data]) => ({ vendorName, ...data }))
    .sort((a, b) => b.totalAmount - a.totalAmount);

  res.json(result);
}));

router.get("/approval-timeline", wrap(async (req, res) => {
  const where: Record<string, any> = {};
  if (req.query.docType) where.docType = req.query.docType as string;

  const submits = await prisma.approval.findMany({
    where: { ...where, action: "SUBMIT" },
    select: { docType: true, docId: true, createdAt: true },
  });
  const approves = await prisma.approval.findMany({
    where: { ...where, action: "APPROVE" },
    select: { docType: true, docId: true, createdAt: true },
  });

  const approveMap: Record<string, Date> = {};
  for (const a of approves) {
    approveMap[`${a.docType}:${a.docId}`] = a.createdAt;
  }

  const durations: number[] = [];
  for (const s of submits) {
    const key = `${s.docType}:${s.docId}`;
    const approveDate = approveMap[key];
    if (approveDate) {
      durations.push(approveDate.getTime() - s.createdAt.getTime());
    }
  }

  if (durations.length === 0) {
    res.json({ count: 0, avgMs: 0, minMs: 0, maxMs: 0 });
    return;
  }

  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  res.json({
    count: durations.length,
    avgMs: Math.round(avg),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
  });
}));

router.get("/export/:type", wrap(async (req, res) => {
  const { type } = req.params;
  const where: Record<string, string> = {};
  if (req.query.projectId) where.projectId = req.query.projectId as string;

  switch (type) {
    case "po-list": {
      const data = await prisma.purchaseOrder.findMany({
        where,
        include: { legalEntity: true, project: true },
        orderBy: { createdAt: "desc" },
      });
      res.json({ type, count: data.length, data });
      break;
    }
    case "payment-list": {
      const data = await prisma.paymentClaim.findMany({
        where,
        include: { legalEntity: true, project: true },
        orderBy: { createdAt: "desc" },
      });
      res.json({ type, count: data.length, data });
      break;
    }
    case "budget-status": {
      const data = await prisma.budget.findMany({
        where: req.query.projectId ? { projectId: req.query.projectId as string } : {},
        include: { project: true },
      });
      res.json({ type, count: data.length, data });
      break;
    }
    default:
      throw new AppError(400, `Unknown export type: ${type}. Valid: po-list, payment-list, budget-status`);
  }
}));

export default router;
