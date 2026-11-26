import express from "express";
import cors from "cors";
import { authMiddleware } from "./middleware/auth";
import { auditMiddleware } from "./middleware/audit-log";
import { errorHandler } from "./middleware/error-handler";
import authRouter from "./routes/auth";
import projectsRouter from "./routes/projects";
import subcontractPlansRouter from "./routes/subcontract-plans";
import engineeringBudgetsRouter from "./routes/engineering-budgets";
import siteRequestsRouter from "./routes/site-requests";
import purchaseRequestsRouter from "./routes/purchase-requests";
import purchaseOrdersRouter from "./routes/purchase-orders";
import inspectionsRouter from "./routes/inspections";
import paymentClaimsRouter from "./routes/payment-claims";
import vouchersRouter from "./routes/vouchers";
import changeOrdersRouter from "./routes/change-orders";
import budgetsRouter from "./routes/budgets";
import auditLogsRouter from "./routes/audit-logs";
import notificationsRouter from "./routes/notifications";
import unitPricesRouter from "./routes/unit-prices";
import ocrRouter from "./routes/ocr";
import reportsRouter from "./routes/reports";

const app = express();

app.use(cors());
app.use(express.json());

// Public routes
app.use("/api/v1/auth", authRouter);

// Protected routes (with auth + audit logging)
app.use("/api/v1/projects", authMiddleware, auditMiddleware, projectsRouter);
app.use("/api/v1/subcontract-plans", authMiddleware, auditMiddleware, subcontractPlansRouter);
app.use("/api/v1/engineering-budgets", authMiddleware, auditMiddleware, engineeringBudgetsRouter);
app.use("/api/v1/site-requests", authMiddleware, auditMiddleware, siteRequestsRouter);
app.use("/api/v1/purchase-requests", authMiddleware, auditMiddleware, purchaseRequestsRouter);
app.use("/api/v1/purchase-orders", authMiddleware, auditMiddleware, purchaseOrdersRouter);
app.use("/api/v1/inspections", authMiddleware, auditMiddleware, inspectionsRouter);
app.use("/api/v1/payment-claims", authMiddleware, auditMiddleware, paymentClaimsRouter);
app.use("/api/v1/vouchers", authMiddleware, auditMiddleware, vouchersRouter);
app.use("/api/v1/change-orders", authMiddleware, auditMiddleware, changeOrdersRouter);
app.use("/api/v1/budgets", authMiddleware, auditMiddleware, budgetsRouter);
app.use("/api/v1/audit-logs", authMiddleware, auditLogsRouter);
app.use("/api/v1/notifications", authMiddleware, notificationsRouter);
app.use("/api/v1/unit-prices", authMiddleware, auditMiddleware, unitPricesRouter);
app.use("/api/v1/ocr", authMiddleware, ocrRouter);
app.use("/api/v1/reports", authMiddleware, reportsRouter);

app.use(errorHandler);

export default app;
