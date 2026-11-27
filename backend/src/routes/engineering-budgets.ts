import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { AppError } from "../middleware/error-handler";
import { generateDocNumber } from "../services/doc-number";

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
    prisma.engineeringBudget.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { legalEntity: true, project: true, subcontractPlan: true },
    }),
    prisma.engineeringBudget.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.post("/", wrap(async (req, res) => {
  const { legalEntityId, projectId, subcontractPlanId, title, description, items } = req.body;
  const user = req.user!;

  const approvedPlan = await prisma.subcontractPlan.findFirst({
    where: { projectId, status: "APPROVED" },
  });
  if (!approvedPlan) throw new AppError(400, "專案尚未有已核准的分包計畫表，無法建立工程預算書");

  const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
  if (idempotencyKey) {
    const existing = await prisma.engineeringBudget.findUnique({ where: { idempotencyKey } });
    if (existing) { res.status(200).json(existing); return; }
  }

  const docNumber = await generateDocNumber(legalEntityId, "ENGINEERING_BUDGET");

  const parsedItems = Array.isArray(items) ? items : [];
  const totalAmount = parsedItems.reduce((sum: number, it: { amount?: number }) => sum + (it.amount || 0), 0);

  const record = await prisma.engineeringBudget.create({
    data: {
      docNumber,
      legalEntityId,
      projectId,
      subcontractPlanId: subcontractPlanId || approvedPlan.id,
      createdBy: user.id,
      updatedBy: user.id,
      title,
      description: description || null,
      items: JSON.stringify(parsedItems),
      totalAmount,
      ...(idempotencyKey && { idempotencyKey }),
    },
  });
  res.status(201).json(record);
}));

router.get("/:id", wrap(async (req, res) => {
  const record = await prisma.engineeringBudget.findUnique({
    where: { id: req.params.id },
    include: { legalEntity: true, project: true, subcontractPlan: true },
  });
  if (!record) throw new AppError(404, "EngineeringBudget not found");
  res.json(record);
}));

router.put("/:id", wrap(async (req, res) => {
  const { rowVersion, title, description, items, subcontractPlanId } = req.body;
  if (rowVersion == null) throw new AppError(400, "rowVersion is required");

  const current = await prisma.engineeringBudget.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError(404, "EngineeringBudget not found");
  if (current.status !== "DRAFT" && current.status !== "REJECTED") {
    throw new AppError(400, `Cannot update: status is ${current.status}`);
  }
  if (current.rowVersion !== rowVersion) {
    throw new AppError(409, `Version conflict: expected ${current.rowVersion}, got ${rowVersion}`);
  }

  let totalAmount = current.totalAmount;
  if (items !== undefined) {
    const parsedItems = Array.isArray(items) ? items : [];
    totalAmount = parsedItems.reduce((sum: number, it: { amount?: number }) => sum + (it.amount || 0), 0);
  }

  const updated = await prisma.engineeringBudget.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(subcontractPlanId !== undefined && { subcontractPlanId }),
      ...(items !== undefined && { items: JSON.stringify(items) }),
      totalAmount,
      updatedBy: req.user!.id,
      rowVersion: { increment: 1 },
    },
  });
  res.json(updated);
}));

router.post("/:id/submit", wrap(async (req, res) => {
  const record = await prisma.engineeringBudget.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "EngineeringBudget not found");
  if (record.status !== "DRAFT") throw new AppError(400, `Cannot submit: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.engineeringBudget.update({
      where: { id: req.params.id },
      data: { status: "PENDING", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "ENGINEERING_BUDGET",
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
  const record = await prisma.engineeringBudget.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "EngineeringBudget not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot approve: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.engineeringBudget.update({
      where: { id: req.params.id },
      data: { status: "APPROVED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "ENGINEERING_BUDGET",
        docId: req.params.id,
        action: "APPROVE",
        comment: req.body.comment || null,
        actorId: req.user!.id,
        actorName: req.user!.name,
      },
    }),
  ]);

  // Auto-activate project
  await prisma.project.update({
    where: { id: record.projectId },
    data: { status: "ACTIVE" },
  });

  // Auto-create budget records from items
  const items = JSON.parse(record.items) as Array<{ category: string; amount: number }>;
  const categoryTotals: Record<string, number> = {};
  let grandTotal = 0;
  for (const item of items) {
    categoryTotals[item.category] = (categoryTotals[item.category] || 0) + item.amount;
    grandTotal += item.amount;
  }
  for (const [category, amount] of Object.entries(categoryTotals)) {
    await prisma.budget.upsert({
      where: { projectId_category: { projectId: record.projectId, category } },
      create: { projectId: record.projectId, category, budgetAmount: amount },
      update: { budgetAmount: amount },
    });
  }
  await prisma.budget.upsert({
    where: { projectId_category: { projectId: record.projectId, category: "TOTAL" } },
    create: { projectId: record.projectId, category: "TOTAL", budgetAmount: grandTotal },
    update: { budgetAmount: grandTotal },
  });

  res.json(updated);
}));

router.post("/:id/reject", wrap(async (req, res) => {
  const record = await prisma.engineeringBudget.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "EngineeringBudget not found");
  if (record.status !== "PENDING") throw new AppError(400, `Cannot reject: status is ${record.status}`);

  const [updated] = await prisma.$transaction([
    prisma.engineeringBudget.update({
      where: { id: req.params.id },
      data: { status: "REJECTED", updatedBy: req.user!.id, rowVersion: { increment: 1 } },
    }),
    prisma.approval.create({
      data: {
        docType: "ENGINEERING_BUDGET",
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
