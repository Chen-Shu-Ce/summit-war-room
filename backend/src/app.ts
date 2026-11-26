import express from "express";
import cors from "cors";
import { authMiddleware } from "./middleware/auth";
import { errorHandler } from "./middleware/error-handler";
import siteRequestsRouter from "./routes/site-requests";
import purchaseRequestsRouter from "./routes/purchase-requests";
import purchaseOrdersRouter from "./routes/purchase-orders";
import inspectionsRouter from "./routes/inspections";
import paymentClaimsRouter from "./routes/payment-claims";
import authRouter from "./routes/auth";

const app = express();

app.use(cors());
app.use(express.json());

// Public routes
app.use("/api/v1/auth", authRouter);

// Protected routes
app.use("/api/v1/site-requests", authMiddleware, siteRequestsRouter);
app.use("/api/v1/purchase-requests", authMiddleware, purchaseRequestsRouter);
app.use("/api/v1/purchase-orders", authMiddleware, purchaseOrdersRouter);
app.use("/api/v1/inspections", authMiddleware, inspectionsRouter);
app.use("/api/v1/payment-claims", authMiddleware, paymentClaimsRouter);

app.use(errorHandler);

export default app;
