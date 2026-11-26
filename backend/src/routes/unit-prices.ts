import { Router, Request, Response, NextFunction } from "express";
import prisma from "../prisma";
import { AppError } from "../middleware/error-handler";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.get("/", wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where: Record<string, unknown> = {};
  if (req.query.category) where.category = req.query.category as string;
  if (req.query.itemName) where.itemName = { contains: req.query.itemName as string };
  if (req.query.region) where.region = req.query.region as string;

  const [data, total] = await Promise.all([
    prisma.unitPriceRecord.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { recordDate: "desc" },
    }),
    prisma.unitPriceRecord.count({ where }),
  ]);
  res.json({ data, total, page, pageSize });
}));

router.post("/", wrap(async (req, res) => {
  const { category, itemName, unit, unitPrice, vendorName, sourceDoc, region } = req.body;
  if (!category || !itemName || !unit || unitPrice == null) {
    throw new AppError(400, "category, itemName, unit, unitPrice are required");
  }
  const record = await prisma.unitPriceRecord.create({
    data: {
      category,
      itemName,
      unit,
      unitPrice,
      vendorName: vendorName || null,
      sourceDoc: sourceDoc ? JSON.stringify(sourceDoc) : null,
      region: region || null,
    },
  });
  res.status(201).json(record);
}));

router.post("/batch", wrap(async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    throw new AppError(400, "records array is required");
  }
  const created = await prisma.unitPriceRecord.createMany({
    data: records.map((r: Record<string, unknown>) => ({
      category: r.category as string,
      itemName: r.itemName as string,
      unit: r.unit as string,
      unitPrice: r.unitPrice as number,
      vendorName: (r.vendorName as string) || null,
      sourceDoc: r.sourceDoc ? JSON.stringify(r.sourceDoc) : null,
      region: (r.region as string) || null,
    })),
  });
  res.status(201).json({ imported: created.count });
}));

router.get("/analysis", wrap(async (req, res) => {
  const { itemName, category } = req.query;
  if (!itemName) throw new AppError(400, "itemName is required");

  const where: Record<string, unknown> = { itemName: itemName as string };
  if (category) where.category = category as string;

  const records = await prisma.unitPriceRecord.findMany({
    where,
    orderBy: { recordDate: "desc" },
  });

  if (records.length === 0) {
    res.json({ itemName, category: category || null, avgPrice: 0, minPrice: 0, maxPrice: 0, medianPrice: 0, recordCount: 0, records: [] });
    return;
  }

  const prices = records.map((r) => r.unitPrice).sort((a, b) => a - b);
  const sum = prices.reduce((s, p) => s + p, 0);
  const mid = Math.floor(prices.length / 2);
  const medianPrice = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];

  res.json({
    itemName,
    category: category || null,
    avgPrice: Math.round((sum / prices.length) * 100) / 100,
    minPrice: prices[0],
    maxPrice: prices[prices.length - 1],
    medianPrice: Math.round(medianPrice * 100) / 100,
    recordCount: records.length,
    records: records.slice(0, 10),
  });
}));

router.post("/compare", wrap(async (req, res) => {
  const { itemName, category, quotedPrice } = req.body;
  if (!itemName || !category || quotedPrice == null) {
    throw new AppError(400, "itemName, category, quotedPrice are required");
  }

  const records = await prisma.unitPriceRecord.findMany({
    where: { itemName, category },
  });

  if (records.length === 0) {
    res.json({ quotedPrice, avgHistorical: null, priceDiffPercent: null, assessment: "NO_DATA", message: "No historical price data for this item" });
    return;
  }

  const avg = records.reduce((s, r) => s + r.unitPrice, 0) / records.length;
  const diffPercent = Math.round(((quotedPrice - avg) / avg) * 10000) / 100;
  let assessment = "NORMAL";
  if (diffPercent > 20) assessment = "HIGH";
  else if (diffPercent < -20) assessment = "LOW";

  res.json({
    quotedPrice,
    avgHistorical: Math.round(avg * 100) / 100,
    priceDiffPercent: diffPercent,
    assessment,
  });
}));

export default router;
