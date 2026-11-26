import { Request, Response, NextFunction } from "express";
import prisma from "../prisma";

const RESOURCE_MAP: Record<string, string> = {
  "projects": "PROJECT",
  "subcontract-plans": "SUBCONTRACT_PLAN",
  "engineering-budgets": "ENGINEERING_BUDGET",
  "site-requests": "SR",
  "purchase-requests": "PR",
  "purchase-orders": "PO",
  "inspections": "INSPECTION",
  "payment-claims": "PAYMENT_CLAIM",
  "change-orders": "CHANGE_ORDER",
  "vouchers": "VOUCHER",
  "budgets": "BUDGET",
  "notifications": "NOTIFICATION",
  "unit-prices": "UNIT_PRICE",
};

const STATUS_CHANGE_SUFFIXES = [
  "/submit", "/approve", "/reject", "/complete",
  "/issue", "/convert-pr", "/convert-po", "/confirm",
  "/register",
];

const METHOD_ACTION: Record<string, string> = {
  POST: "CREATE",
  PUT: "UPDATE",
  PATCH: "UPDATE",
  DELETE: "DELETE",
};

function resolveResource(baseUrl: string): string | null {
  const segment = baseUrl.replace(/^\/api\/v\d+\//, "").split("/")[0];
  return RESOURCE_MAP[segment] || null;
}

function resolveAction(method: string, path: string): string {
  if (STATUS_CHANGE_SUFFIXES.some((s) => path.endsWith(s))) return "STATUS_CHANGE";
  return METHOD_ACTION[method] || method;
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }

  const body = req.body ? JSON.stringify(req.body) : null;

  res.on("finish", () => {
    if (res.statusCode >= 400) return;

    const user = req.user;
    if (!user) return;

    const resource = resolveResource(req.baseUrl);
    if (!resource) return;

    const action = resolveAction(req.method, req.path);
    const resourceId = req.params?.id || null;

    prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorName: user.name,
        action,
        resource,
        resourceId,
        detail: body,
        ip: req.ip || null,
      },
    }).catch(() => {});
  });

  next();
}
