import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { PrismaClient, UserRole } from '@prisma/client';
import { signToken } from '../utils/jwt';

const prisma = new PrismaClient();

const registerSchema = z.object({
  phone: z.string().regex(/^\+?977[0-9]{9,10}$|^9[0-9]{9}$/, 'Invalid Nepal phone number'),
  name: z.string().min(2),
  password: z.string().min(6),
  role: z.nativeEnum(UserRole).optional(),
});

const loginSchema = z.object({
  phone: z.string(),
  password: z.string(),
});

export async function register(req: Request, res: Response) {
  const data = registerSchema.parse(req.body);
  const phone = normalizePhone(data.phone);

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) return res.status(400).json({ error: 'Phone already registered' });

  const passwordHash = await bcrypt.hash(data.password, 12);
  const user = await prisma.user.create({
    data: { phone, name: data.name, passwordHash, role: data.role || 'DRIVER' },
    select: { id: true, phone: true, name: true, role: true },
  });

  const token = signToken({ userId: user.id, role: user.role });
  res.status(201).json({ user, token });
}

export async function login(req: Request, res: Response) {
  const { phone, password } = loginSchema.parse(req.body);
  const normalized = normalizePhone(phone);

  const user = await prisma.user.findUnique({ where: { phone: normalized } });
  if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ userId: user.id, role: user.role });
  res.json({
    user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
    token,
  });
}

export async function me(req: any, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, phone: true, name: true, email: true, role: true, profilePhoto: true },
  });
  res.json(user);
}

function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, '');
  if (digits.startsWith('977')) return '+' + digits;
  if (digits.startsWith('0')) return '+977' + digits.slice(1);
  if (digits.length === 10 && digits.startsWith('9')) return '+977' + digits;
  return '+' + digits;
}