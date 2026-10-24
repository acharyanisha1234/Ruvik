import { Response } from 'express';
import { z } from 'zod';
import { PrismaClient, ServiceCategory, RequestStatus } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { findMatchingProviders } from '../services/matching.service';
import { getIO } from '../socket';

const prisma = new PrismaClient();

const PROBLEM_TO_CATEGORY: Record<string, ServiceCategory> = {
  ENGINE: 'MECHANIC',
  OVERHEATING: 'MECHANIC',
  ELECTRICAL: 'MECHANIC',
  TYRE: 'TYRE',
  PUNCTURE: 'TYRE',
  BATTERY: 'BATTERY',
  JUMP_START: 'BATTERY',
  FUEL: 'FUEL',
  LOCKOUT: 'LOCKSMITH',
  TOWING: 'TOWING',
  RECOVERY: 'RECOVERY',
};

const createSchema = z.object({
  vehicleId: z.string(),
  problemType: z.string(),
  description: z.string().optional(),
  photoUrl: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  address: z.string().optional(),
  urgency: z.enum(['NORMAL', 'URGENT', 'EMERGENCY']).default('NORMAL'),
});

export async function createBreakdownRequest(req: AuthRequest, res: Response) {
  const data = createSchema.parse(req.body);

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: data.vehicleId, ownerId: req.userId },
  });
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found or not yours' });

  const request = await prisma.breakdownRequest.create({
    data: {
      driverId: req.userId!,
      vehicleId: data.vehicleId,
      problemType: data.problemType,
      description: data.description,
      photoUrl: data.photoUrl,
      latitude: data.latitude,
      longitude: data.longitude,
      address: data.address,
      urgency: data.urgency,
    },
  });

  const category = PROBLEM_TO_CATEGORY[data.problemType] || 'MECHANIC';
  const providers = await findMatchingProviders(
    data.latitude,
    data.longitude,
    category,
    10
  );

  // Notify all matched providers via socket
  const io = getIO();
  providers.forEach((p) => {
    io.to(`provider_${p.id}`).emit('new_breakdown_request', {
      requestId: request.id,
      problemType: data.problemType,
      description: data.description,
      latitude: data.latitude,
      longitude: data.longitude,
      distanceKm: p.distanceKm,
      urgency: data.urgency,
    });
  });

  res.status(201).json({ request, recommendedProviders: providers });
}

export async function listMyRequests(req: AuthRequest, res: Response) {
  const requests = await prisma.breakdownRequest.findMany({
    where: { driverId: req.userId },
    include: {
      vehicle: true,
      serviceRequests: {
        include: { provider: { select: { businessName: true, phone: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(requests);
}

export async function getRequest(req: AuthRequest, res: Response) {
  const request = await prisma.breakdownRequest.findFirst({
    where: { id: req.params.id, driverId: req.userId },
    include: {
      vehicle: true,
      serviceRequests: {
        include: {
          provider: {
            select: { id: true, businessName: true, phone: true, latitude: true, longitude: true },
          },
        },
      },
    },
  });
  if (!request) return res.status(404).json({ error: 'Not found' });
  res.json(request);
}

const sendSchema = z.object({
  breakdownRequestId: z.string(),
  providerId: z.string(),
});

export async function sendRequestToProvider(req: AuthRequest, res: Response) {
  const { breakdownRequestId, providerId } = sendSchema.parse(req.body);

  const breakdown = await prisma.breakdownRequest.findFirst({
    where: { id: breakdownRequestId, driverId: req.userId },
  });
  if (!breakdown) return res.status(404).json({ error: 'Breakdown not found' });

  const existing = await prisma.serviceRequest.findUnique({
    where: { breakdownRequestId_providerId: { breakdownRequestId, providerId } },
  });
  if (existing) return res.status(409).json({ error: 'Request already sent to this provider' });

  const serviceRequest = await prisma.serviceRequest.create({
    data: { breakdownRequestId, providerId, status: 'REQUESTED' },
    include: { provider: true },
  });

  await prisma.serviceProvider.update({
    where: { id: providerId },
    data: { totalRequests: { increment: 1 } },
  });

  const io = getIO();
  io.to(`provider_${providerId}`).emit('incoming_request', serviceRequest);
  res.status(201).json(serviceRequest);
}

const updateStatusSchema = z.object({
  status: z.nativeEnum(RequestStatus),
  etaMinutes: z.number().int().positive().optional(),
  finalCost: z.number().nonnegative().optional(),
});

export async function updateServiceRequestStatus(req: AuthRequest, res: Response) {
  const { status, etaMinutes, finalCost } = updateStatusSchema.parse(req.body);
  const { id } = req.params;

  const serviceRequest = await prisma.serviceRequest.findUnique({
    where: { id },
    include: { provider: true, breakdownRequest: true },
  });
  if (!serviceRequest) return res.status(404).json({ error: 'Not found' });

  // Authorization: provider owner OR requesting driver
  const isProvider = serviceRequest.provider.userId === req.userId;
  const isDriver = serviceRequest.breakdownRequest.driverId === req.userId;
  if (!isProvider && !isDriver) return res.status(403).json({ error: 'Forbidden' });

  const updated = await prisma.serviceRequest.update({
    where: { id },
    data: {
      status,
      ...(etaMinutes ? { etaMinutes } : {}),
      ...(finalCost ? { finalCost } : {}),
    },
    include: { provider: true },
  });

  // Side effects
  if (status === 'ACCEPTED') {
    await prisma.serviceProvider.update({
      where: { id: serviceRequest.providerId },
      data: { acceptedRequests: { increment: 1 } },
    });
    await prisma.breakdownRequest.update({
      where: { id: serviceRequest.breakdownRequestId },
      data: { status: 'ACCEPTED' },
    });
  }
  if (status === 'COMPLETED') {
    await prisma.serviceProvider.update({
      where: { id: serviceRequest.providerId },
      data: { completedRequests: { increment: 1 } },
    });
    await prisma.breakdownRequest.update({
      where: { id: serviceRequest.breakdownRequestId },
      data: { status: 'COMPLETED' },
    });
    const { updateReliability } = await import('../services/matching.service');
    await updateReliability(serviceRequest.providerId);
  }

  // Broadcast to both driver and provider rooms
  const io = getIO();
  io.to(`request_${serviceRequest.breakdownRequestId}`).emit('request_status_updated', {
    serviceRequestId: id,
    status,
    etaMinutes,
    finalCost,
  });
  io.to(`provider_${serviceRequest.providerId}`).emit('request_status_updated', {
    serviceRequestId: id,
    status,
  });

  res.json(updated);
}