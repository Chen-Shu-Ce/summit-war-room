import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { AppError } from "../middleware/error-handler";
import { sendNotification, sendNotificationBulk } from "../services/notification";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get("/", wrap(async (req, res) => {
  const userId = req.user!.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const where: Record<string, unknown> = { userId };
  if (req.query.read !== undefined) where.read = req.query.read === "true";
  if (req.query.type) where.type = req.query.type as string;

  const [data, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);
  res.json({ data, total, unreadCount, page, pageSize });
}));

router.get("/:id", wrap(async (req, res) => {
  const record = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Notification not found");
  if (record.userId !== req.user!.id) throw new AppError(403, "Forbidden");
  res.json(record);
}));

router.post("/:id/read", wrap(async (req, res) => {
  const record = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!record) throw new AppError(404, "Notification not found");
  if (record.userId !== req.user!.id) throw new AppError(403, "Forbidden");

  const updated = await prisma.notification.update({
    where: { id: req.params.id },
    data: { read: true },
  });
  res.json(updated);
}));

router.post("/read-all", wrap(async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user!.id, read: false },
    data: { read: true },
  });
  res.json({ updated: result.count });
}));

router.post("/send", wrap(async (req, res) => {
  const { userId, type, channel, title, body, relatedDoc } = req.body;
  if (!userId || !type || !title || !body) {
    throw new AppError(400, "userId, type, title, body are required");
  }
  const record = await sendNotification({ userId, type, channel, title, body, relatedDoc });
  res.status(201).json(record);
}));

router.post("/send-bulk", wrap(async (req, res) => {
  const { userIds, type, channel, title, body, relatedDoc } = req.body;
  if (!userIds?.length || !type || !title || !body) {
    throw new AppError(400, "userIds, type, title, body are required");
  }
  const result = await sendNotificationBulk(userIds, { type, channel, title, body, relatedDoc });
  res.status(201).json({ created: result.count });
}));

export default router;
