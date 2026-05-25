import Redis from 'ioredis';
import { getRedisClient } from '../config/redis.config';
import { logger } from '../utils/logger';

export interface CachedLocation {
    latitude: number;
    longitude: number;
    speed?: number;
    heading?: number;
    accuracy?: number;
    batteryLevel?: number;
    timestamp: string;
}

export interface EtaData {
    busId: string;
    estimatedArrival: string;
    distanceMeters: number;
    durationSeconds: number;
    currentStopId: string;
    nextStopId: string;
}

export const redisService = {
    /**
     * Cache driver's latest location
     */
    async cacheDriverLocation(
        driverId: string,
        location: CachedLocation,
        ttlSeconds = 30
    ): Promise<void> {
        try {
            const redis = getRedisClient();
            const key = `location:driver_${driverId}`;
            await redis.setex(key, ttlSeconds, JSON.stringify(location));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to cache driver location: ${message}`);
        }
    },

    /**
     * Get cached driver location
     */
    async getDriverLocation(driverId: string): Promise<CachedLocation | null> {
        try {
            const redis = getRedisClient();
            const key = `location:driver_${driverId}`;
            const data = await redis.get(key);
            if (!data) {
                return null;
            }
            return JSON.parse(data) as CachedLocation;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get driver location from cache: ${message}`);
            return null;
        }
    },

    /**
     * Cache trip's latest location (aggregated from driver)
     */
    async cacheTripLocation(
        tripId: string,
        location: Omit<CachedLocation, 'batteryLevel'>,
        ttlSeconds = 30
    ): Promise<void> {
        try {
            const redis = getRedisClient();
            const key = `location:trip_${tripId}`;
            await redis.setex(key, ttlSeconds, JSON.stringify(location));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to cache trip location: ${message}`);
        }
    },

    /**
     * Get cached trip location
     */
    async getTripLocation(tripId: string): Promise<Omit<CachedLocation, 'batteryLevel'> | null> {
        try {
            const redis = getRedisClient();
            const key = `location:trip_${tripId}`;
            const data = await redis.get(key);
            if (!data) {
                return null;
            }
            return JSON.parse(data) as Omit<CachedLocation, 'batteryLevel'>;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get trip location from cache: ${message}`);
            return null;
        }
    },

    /**
     * Cache bus location
     */
    async cacheBusLocation(
        busId: string,
        location: Omit<CachedLocation, 'batteryLevel'>,
        tripId?: string,
        ttlSeconds = 30
    ): Promise<void> {
        try {
            const redis = getRedisClient();
            const key = `location:bus_${busId}`;
            const payload = tripId ? { ...location, tripId } : location;
            await redis.setex(key, ttlSeconds, JSON.stringify(payload));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to cache bus location: ${message}`);
        }
    },

    /**
     * Get cached bus location
     */
    async getBusLocation(busId: string): Promise<(Omit<CachedLocation, 'batteryLevel'> & { tripId?: string }) | null> {
        try {
            const redis = getRedisClient();
            const key = `location:bus_${busId}`;
            const data = await redis.get(key);
            if (!data) {
                return null;
            }
            return JSON.parse(data) as Omit<CachedLocation, 'batteryLevel'> & { tripId?: string };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get bus location from cache: ${message}`);
            return null;
        }
    },

    /**
     * Add driver to geospatial index for trip
     */
    async addDriverToGeoIndex(
        tripId: string,
        longitude: number,
        latitude: number,
        driverId: string
    ): Promise<void> {
        try {
            const redis = getRedisClient();
            const key = `geo:trip_${tripId}:drivers`;
            await redis.geoadd(key, longitude, latitude, driverId);
            // Set TTL on the geospatial index
            await redis.expire(key, 60);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to add driver to geo index: ${message}`);
        }
    },

    /**
     * Find nearby drivers within radius from a location
     */
    async findNearbyDrivers(
        tripId: string,
        longitude: number,
        latitude: number,
        radiusKm = 5
    ): Promise<string[]> {
        try {
            const redis = getRedisClient();
            const key = `geo:trip_${tripId}:drivers`;
            const drivers = await redis.geosearch(
                key,
                'FROMMEMBER',
                tripId,  // Use tripId as center reference
                'BYRADIUS',
                radiusKm,
                'km',
                'COUNT',
                1000  // Max 1000 results
            );
            return drivers as string[];
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to find nearby drivers: ${message}`);
            return [];
        }
    },

    /**
     * Cache ETA for a trip stop
     */
    async cacheEta(tripId: string, stopId: string, eta: EtaData, ttlSeconds = 60): Promise<void> {
        try {
            const redis = getRedisClient();
            const key = `eta:trip_${tripId}:stop_${stopId}`;
            await redis.setex(key, ttlSeconds, JSON.stringify(eta));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to cache ETA: ${message}`);
        }
    },

    /**
     * Get cached ETA
     */
    async getEta(tripId: string, stopId: string): Promise<EtaData | null> {
        try {
            const redis = getRedisClient();
            const key = `eta:trip_${tripId}:stop_${stopId}`;
            const data = await redis.get(key);
            if (!data) {
                return null;
            }
            return JSON.parse(data) as EtaData;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get ETA from cache: ${message}`);
            return null;
        }
    },

    /**
     * Cache trip state
     */
    async cacheTripState(
        tripId: string,
        state: Record<string, unknown>,
        ttlSeconds = 120
    ): Promise<void> {
        try {
            const redis = getRedisClient();
            const key = `state:trip_${tripId}`;
            await redis.setex(key, ttlSeconds, JSON.stringify(state));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to cache trip state: ${message}`);
        }
    },

    /**
     * Get cached trip state
     */
    async getTripState(tripId: string): Promise<Record<string, unknown> | null> {
        try {
            const redis = getRedisClient();
            const key = `state:trip_${tripId}`;
            const data = await redis.get(key);
            if (!data) {
                return null;
            }
            return JSON.parse(data) as Record<string, unknown>;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get trip state from cache: ${message}`);
            return null;
        }
    },

    /**
     * Check if request nonce already processed (replay attack prevention)
     */
    async isNonceProcessed(nonce: string): Promise<boolean> {
        try {
            const redis = getRedisClient();
            const key = `replay:nonce:${nonce}`;
            const exists = await redis.exists(key);
            return exists === 1;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to check nonce: ${message}`);
            return false;
        }
    },

    /**
     * Mark nonce as processed (1 hour TTL)
     */
    async markNonceProcessed(nonce: string): Promise<void> {
        try {
            const redis = getRedisClient();
            const key = `replay:nonce:${nonce}`;
            await redis.setex(key, 3600, 'true');
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to mark nonce processed: ${message}`);
        }
    },

    /**
     * Increment rate limit counter for driver
     */
    async incrementRateLimit(driverId: string, windowSeconds = 60): Promise<number> {
        try {
            const redis = getRedisClient();
            const key = `ratelimit:driver:${driverId}`;
            const count = await redis.incr(key);
            if (count === 1) {
                await redis.expire(key, windowSeconds);
            }
            return count;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to increment rate limit: ${message}`);
            return 0;
        }
    },

    /**
     * Get rate limit count for driver
     */
    async getRateLimitCount(driverId: string): Promise<number> {
        try {
            const redis = getRedisClient();
            const key = `ratelimit:driver:${driverId}`;
            const count = await redis.get(key);
            return count ? parseInt(count, 10) : 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get rate limit count: ${message}`);
            return 0;
        }
    },

    /**
     * Clear all cache for a trip
     */
    async clearTripCache(tripId: string): Promise<void> {
        try {
            const redis = getRedisClient();
            const keys = await redis.keys(`*:trip_${tripId}*`);
            if (keys.length > 0) {
                await redis.del(...keys);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to clear trip cache: ${message}`);
        }
    },

    /**
     * Clear all cache for a driver
     */
    async clearDriverCache(driverId: string): Promise<void> {
        try {
            const redis = getRedisClient();
            const keys = await redis.keys(`*:driver_${driverId}*`);
            if (keys.length > 0) {
                await redis.del(...keys);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to clear driver cache: ${message}`);
        }
    },

    /**
     * Get Redis client for custom operations
     */
    getClient(): Redis {
        return getRedisClient();
    },
};
