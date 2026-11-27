import { Router, Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler";

const router = Router();

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res, next).catch(next);

router.post("/scan", wrap(async (req, res) => {
  const { fileType, fileName } = req.body;
  if (!fileType || !fileName) {
    throw new AppError(400, "fileType and fileName are required");
  }

  if (fileType === "quotation") {
    res.json({
      fileType,
      fileName,
      vendorName: "模擬廠商 A",
      items: [
        { name: "SD420 #8 鋼筋", qty: 50, unit: "噸", unitPrice: 28000, amount: 1400000 },
        { name: "模板 (4×8)", qty: 200, unit: "片", unitPrice: 450, amount: 90000 },
      ],
      totalAmount: 1490000,
      confidence: 0.92,
      ocrEngine: "mock",
      message: "此為模擬 OCR 結果，正式環境將串接實際 OCR 服務",
    });
  } else if (fileType === "invoice") {
    res.json({
      fileType,
      fileName,
      vendorName: "模擬廠商 A",
      invoiceNumber: "AB-12345678",
      invoiceDate: new Date().toISOString().slice(0, 10),
      items: [
        { name: "SD420 #8 鋼筋", qty: 50, unit: "噸", unitPrice: 28000, amount: 1400000 },
      ],
      taxAmount: 70000,
      totalAmount: 1470000,
      confidence: 0.88,
      ocrEngine: "mock",
      message: "此為模擬 OCR 結果，正式環境將串接實際 OCR 服務",
    });
  } else {
    throw new AppError(400, "fileType must be 'quotation' or 'invoice'");
  }
}));

router.post("/confirm", wrap(async (req, res) => {
  const { type, data, corrections } = req.body;
  if (!type || !data) {
    throw new AppError(400, "type and data are required");
  }

  const merged = { ...data, ...(corrections || {}) };
  if (corrections?.items && Array.isArray(data.items)) {
    merged.items = data.items.map((item: Record<string, unknown>, i: number) => ({
      ...item,
      ...(corrections.items?.[i] || {}),
    }));
  }

  res.json({ confirmed: true, type, data: merged });
}));

export default router;
