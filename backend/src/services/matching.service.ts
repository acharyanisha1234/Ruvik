import 'dotenv/config';
import { PrismaClient, type ServiceCategory } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { haversineKm } from './geo.service';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is missing in the .env file');
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

interface MatchResult {
  id: string;
  businessName: string;
  phone: string;
  distanceKm: number;
  reliabilityScore: number;
  isVerified: boolean;
  etaMinutes: number;
  explanation: string;
}

export async function findMatchingProviders(
  latitude: number,
  longitude: number,
  category: ServiceCategory,
  limit = 10
): Promise<MatchResult[]> {
  const providers = await prisma.serviceProvider.findMany({
    where: {
      isVerified: true,
      isAvailable: true,
      serviceCategories: { has: category },
    },
    include: {
      user: {
        select: {
          phone: true,
        },
      },
    },
  });

  const ranked = providers
    .map((p) => {
      const exactDistance = haversineKm(
        latitude,
        longitude,
        p.latitude,
        p.longitude
      );

      return {
        id: p.id,
        businessName: p.businessName,
        phone: p.user.phone,
        distanceKm: Math.round(exactDistance * 10) / 10,
        reliabilityScore: p.reliabilityScore,
        isVerified: p.isVerified,
        etaMinutes: Math.round(5 + exactDistance * 3),
        explanation: buildExplanation(
          exactDistance,
          p.reliabilityScore
        ),
        serviceRadiusKm: p.serviceRadiusKm,
        exactDistance,
      };
    })
    .filter((p) => p.exactDistance <= p.serviceRadiusKm)
    .sort((a, b) => {
      // Distance has 60% weight; reliability has 40% weight.
      // Normalize distance to a 0-5 scale before comparing.
      const scoreA =
        (a.distanceKm / Math.max(a.serviceRadiusKm, 1)) * 5 * 0.6 -
        a.reliabilityScore * 0.4;

      const scoreB =
        (b.distanceKm / Math.max(b.serviceRadiusKm, 1)) * 5 * 0.6 -
        b.reliabilityScore * 0.4;

      return scoreA - scoreB;
    })
    .slice(0, Math.max(0, limit));

  return ranked.map(
    ({ serviceRadiusKm: _radius, exactDistance: _distance, ...result }) =>
      result
  );
}

function buildExplanation(
  distanceKm: number,
  reliability: number
): string {
  const parts: string[] = [];

  if (distanceKm < 3) {
    parts.push('Very close to you');
  } else if (distanceKm < 8) {
    parts.push('Nearby');
  }

  if (reliability > 4.5) {
    parts.push('highly rated');
  } else if (reliability > 4.0) {
    parts.push('well rated');
  }

  return parts.length > 0
    ? parts.join(' and ')
    : 'Available provider';
}

export async function updateReliability(
  providerId: string
): Promise<void> {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
  });

  if (!provider || provider.totalRequests === 0) {
    return;
  }

  const acceptanceRate =
    provider.acceptedRequests / provider.totalRequests;

  const completionRate =
    provider.acceptedRequests > 0
      ? provider.completedRequests / provider.acceptedRequests
      : 0;

  const score =
    (acceptanceRate * 0.5 + completionRate * 0.5) * 5;

  await prisma.serviceProvider.update({
    where: { id: providerId },
    data: {
      reliabilityScore: Math.round(score * 100) / 100,
    },
  });
}
