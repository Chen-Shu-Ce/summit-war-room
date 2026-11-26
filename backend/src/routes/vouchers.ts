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
  if (req.query.legalEntityId) where.legalEntityId = req.query.legalEntityId as string;

  const [data, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: { legalEntity: true, paymentClaim: true },
    }),
    prisma.voucher.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.get("/payment-claim/:paymentClaimId", wrap(async (req, res) => {
  const data = await prisma.voucher.findMany({
    where: { paymentClaimId: req.params.paymentClaimId },
    include: { legalEntity: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(data);
}));

router.get("/:id", wrap(async (req, res) => {
  const record = await prisma.voucher.findUnique({
    where: { id: req.params.id },
    include: { legalEntity: true, paymentClaim: true },
  });
  if (!record) throw new AppError(404, "Voucher not found");
  res.json(record);
}));

router.post("/:id/confirm", wrap(async (req, res) => {
  const record = await prisma.voucher.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Voucher not found");
  if (record.status !== "AUTO_CREATED") {
    throw new AppError(400, `Cannot confirm: status is ${record.status}`);
  }

  const updated = await prisma.voucher.update({
    where: { id: req.params.id },
    data: {
      status: "CONFIRMED",
      confirmedBy: req.user!.id,
      confirmedAt: new Date(),
      ...(req.body.debitAccount !== undefined && { debitAccount: req.body.debitAccount }),
      ...(req.body.creditAccount !== undefined && { creditAccount: req.body.creditAccount }),
    },
  });
  res.json(updated);
}));

export default router;
