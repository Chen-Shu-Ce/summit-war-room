import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { signToken } from "../middleware/auth";

const router = Router();

router.post("/login", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const token = signToken({ id: user.id, name: user.name, role: user.role });
  res.json({ token, user });
});

router.get("/users", async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany();
  res.json(users);
});

router.get("/entities", async (_req: Request, res: Response) => {
  const entities = await prisma.legalEntity.findMany();
  res.json(entities);
});

router.get("/projects", async (_req: Request, res: Response) => {
  const projects = await prisma.project.findMany({ include: { legalEntity: true } });
  res.json(projects);
});

export default router;
