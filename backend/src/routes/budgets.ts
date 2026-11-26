import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { AppError } from "../middleware/error-handler";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

function calcAlertLevel(rate: number): string {
  if (rate >= 100) return "OVER";
  if (rate >= 80) return "WARNING";
  return "NORMAL";
}

function calcRate(used: number, budget: number): number {
  if (budget <= 0) return used > 0 ? 100 : 0;
  return Math.round((used / budget) * 10000) / 100;
}

router.get("/project/:projectId", wrap(async (req, res) => {
  const budgets = await prisma.budget.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { category: "asc" },
  });
  res.json(budgets);
}));

router.post("/project/:projectId", wrap(async (req, res) => {
  const { category, budgetAmount } = req.body;
  if (!category || budgetAmount == null) throw new AppError(400, "category and budgetAmount are required");

  const projectId = req.params.projectId;
  const existing = await prisma.budget.findUnique({ where: { projectId_category: { projectId, category } } });
  const usedAmount = existing?.usedAmount ?? 0;
  const executionRate = calcRate(usedAmount, budgetAmount);
  const alertLevel = calcAlertLevel(executionRate);

  const budget = await prisma.budget.upsert({
    where: { projectId_category: { projectId, category } },
    create: { projectId, category, budgetAmount, usedAmount, executionRate, alertLevel },
    update: { budgetAmount, executionRate, alertLevel },
  });
  res.status(201).json(budget);
}));

router.post("/project/:projectId/init", wrap(async (req, res) => {
  const projectId = req.params.projectId;
  const { MATERIAL = 0, EQUIPMENT = 0, ENGINEERING = 0, LABOR = 0 } = req.body;
  const categories: Record<string, number> = { MATERIAL, EQUIPMENT, ENGINEERING, LABOR };
  const total = MATERIAL + EQUIPMENT + ENGINEERING + LABOR;
  categories.TOTAL = total;

  const results = [];
  for (const [category, budgetAmount] of Object.entries(categories)) {
    const budget = await prisma.budget.upsert({
      where: { projectId_category: { projectId, category } },
      create: { projectId, category, budgetAmount, usedAmount: 0, executionRate: 0, alertLevel: "NORMAL" },
      update: { budgetAmount, executionRate: 0, alertLevel: "NORMAL" },
    });
    results.push(budget);
  }
  res.status(201).json(results);
}));

router.put("/:id", wrap(async (req, res) => {
  const { budgetAmount } = req.body;
  if (budgetAmount == null) throw new AppError(400, "budgetAmount is required");

  const current = await prisma.budget.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError(404, "Budget not found");

  const executionRate = calcRate(current.usedAmount, budgetAmount);
  const alertLevel = calcAlertLevel(executionRate);

  const updated = await prisma.budget.update({
    where: { id: req.params.id },
    data: { budgetAmount, executionRate, alertLevel },
  });
  res.json(updated);
}));

router.post("/check", wrap(async (req, res) => {
  const { projectId, category, amount } = req.body;
  if (!projectId || !category || amount == null) throw new AppError(400, "projectId, category, and amount are required");

  const budget = await prisma.budget.findUnique({ where: { projectId_category: { projectId, category } } });
  if (!budget) throw new AppError(404, "Budget not found for this project/category");

  const remaining = budget.budgetAmount - budget.usedAmount;
  const usedAfter = budget.usedAmount + amount;
  const executionRateAfter = calcRate(usedAfter, budget.budgetAmount);
  const alertLevelAfter = calcAlertLevel(executionRateAfter);

  res.json({
    available: amount <= remaining,
    budget: budget.budgetAmount,
    used: budget.usedAmount,
    remaining,
    executionRateAfter,
    alertLevelAfter,
  });
}));

router.post("/consume", wrap(async (req, res) => {
  const { projectId, category, amount, force } = req.body;
  if (!projectId || !category || amount == null) throw new AppError(400, "projectId, category, and amount are required");

  const budget = await prisma.budget.findUnique({ where: { projectId_category: { projectId, category } } });
  if (!budget) throw new AppError(404, "Budget not found for this project/category");

  const remaining = budget.budgetAmount - budget.usedAmount;
  if (amount > remaining && !force) {
    throw new AppError(400, `Insufficient budget: remaining ${remaining}, requested ${amount}. Pass force=true to override.`);
  }

  const usedAmount = budget.usedAmount + amount;
  const executionRate = calcRate(usedAmount, budget.budgetAmount);
  const alertLevel = calcAlertLevel(executionRate);

  const updated = await prisma.budget.update({
    where: { id: budget.id },
    data: { usedAmount, executionRate, alertLevel },
  });
  res.json(updated);
}));

export default router;
