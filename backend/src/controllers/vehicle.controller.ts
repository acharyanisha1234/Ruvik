import { Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';

const prisma = new PrismaClient();

const vehicleSchema = z.object({
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.number().int().min(1980).max(new Date().getFullYear() + 1),
  fuelType: z.enum(['PETROL', 'DIESEL', 'ELECTRIC', 'HYBRID']),
  registrationNumber: z.string().min(2),
  photos: z.array(z.string()).default([]),
  isRentable: z.boolean().default(false),
  dailyRateNpr: z.number().positive().optional(),
});

export async function createVehicle(req: AuthRequest, res: Response) {
  const data = vehicleSchema.parse(req.body);
  const vehicle = await prisma.vehicle.create({
    data: { ...data, ownerId: req.userId! },
  });
  res.status(201).json(vehicle);
}

export async function listMyVehicles(req: AuthRequest, res: Response) {
  const vehicles = await prisma.vehicle.findMany({
    where: { ownerId: req.userId },
    orderBy: { createdAt: 'desc' },
  });
  res.json(vehicles);
}

export async function getVehicle(req: AuthRequest, res: Response) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, ownerId: req.userId },
  });
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(vehicle);
}
export async function deleteVehicle(req: AuthRequest, res: Response) {
  const result = await prisma.vehicle.deleteMany({
    where: { id: req.params.id, ownerId: req.userId },
  });
  if (result.count === 0) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ success: true });
}