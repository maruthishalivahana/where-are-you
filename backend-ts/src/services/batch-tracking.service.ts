import mongoose from 'mongoose';
import { LocationLog } from '../modules/locationLog/locationLog.model';
import { Driver } from '../modules/driver/driver.model';
import { Bus } from '../modules/bus/bus.model';
import { Trip } from '../modules/trip/trip.model';
import { redisService, CachedLocation } from './redis.service';
import { locationValidationService, RawLocation, ValidatedLocation } from './location-validation.service';
import { broadcastService } from './broadcast.service';
import { notificationService } from '../modules/notification/notification.service';
import { logger } from '../utils/logger';
import { calculateDistanceMeters } from '../utils/calculateDistance';

export interface BatchUploadPayload {
    tripId: string;
    driverId: string;
    busId: string;
    batchTimestamp: string;
    nonce: string;
    locations: RawLocation[];
}

export interface BatchProcessingResult {
    success: boolean;
    processedCount: number;
    validCount: number;
    invalidCount: number;
    duplicateCount: number;
    skippedCount: number;
    cacheUpdated: boolean;
    errors?: string[];
}

const MAX_LOCATIONS_PER_BATCH = 100;
const RATE_LIMIT_PER_MINUTE = 10;

export const batchTrackingService = {
    /**
     * Validate batch upload request
     */
    async validateBatchRequest(payload: unknown): Promise<{
        isValid: boolean;
        error?: string;
        validated?: BatchUploadPayload;
    }> {
        // Type validation
        if (!payload || typeof payload !== 'object') {
            return { isValid: false, error: 'Payload must be a non-null object' };
        }

        const p = payload as Record<string, unknown>;

        // Required fields
        if (typeof p.tripId !== 'string' || !p.tripId.trim()) {
            return { isValid: false, error: 'tripId is required and must be a non-empty string' };
        }

        if (typeof p.driverId !== 'string' || !p.driverId.trim()) {
            return { isValid: false, error: 'driverId is required and must be a non-empty string' };
        }

        if (typeof p.busId !== 'string' || !p.busId.trim()) {
            return { isValid: false, error: 'busId is required and must be a non-empty string' };
        }

        if (typeof p.batchTimestamp !== 'string' || !p.batchTimestamp.trim()) {
            return { isValid: false, error: 'batchTimestamp is required' };
        }

        if (typeof p.nonce !== 'string' || !p.nonce.trim()) {
            return { isValid: false, error: 'nonce is required for replay attack prevention' };
        }

        // Locations array
        if (!Array.isArray(p.locations)) {
            return { isValid: false, error: 'locations must be an array' };
        }

        if (p.locations.length === 0) {
            return { isValid: false, error: 'locations array cannot be empty' };
        }

        if (p.locations.length > MAX_LOCATIONS_PER_BATCH) {
            return {
                isValid: false,
                error: `locations array cannot exceed ${MAX_LOCATIONS_PER_BATCH} items`,
            };
        }

        // Validate each location has required fields
        for (const location of p.locations) {
            if (!location || typeof location !== 'object') {
                return { isValid: false, error: 'Each location must be an object' };
            }

            const loc = location as Record<string, unknown>;

            if (typeof loc.latitude !== 'number') {
                return { isValid: false, error: 'Each location must have latitude as number' };
            }

            if (typeof loc.longitude !== 'number') {
                return { isValid: false, error: 'Each location must have longitude as number' };
            }

            if (typeof loc.timestamp !== 'string') {
                return { isValid: false, error: 'Each location must have timestamp' };
            }
        }

        return {
            isValid: true,
            validated: {
                tripId: p.tripId.trim(),
                driverId: p.driverId.trim(),
                busId: p.busId.trim(),
                batchTimestamp: p.batchTimestamp.trim(),
                nonce: p.nonce.trim(),
                locations: p.locations as RawLocation[],
            },
        };
    },

    /**
     * Check rate limit for driver
     */
    async checkRateLimit(driverId: string, limit = RATE_LIMIT_PER_MINUTE): Promise<{
        allowed: boolean;
        remaining: number;
        resetIn: number;
    }> {
        const count = await redisService.incrementRateLimit(driverId, 60);

        return {
            allowed: count <= limit,
            remaining: Math.max(0, limit - count),
            resetIn: 60,
        };
    },

    /**
     * Process batch of locations
     */
    async processBatch(
        organizationId: string,
        payload: BatchUploadPayload
    ): Promise<BatchProcessingResult> {
        const errors: string[] = [];

        try {
            // Check replay attack
            const isProcessed = await redisService.isNonceProcessed(payload.nonce);
            if (isProcessed) {
                return {
                    success: false,
                    processedCount: 0,
                    validCount: 0,
                    invalidCount: payload.locations.length,
                    duplicateCount: 0,
                    skippedCount: payload.locations.length,
                    cacheUpdated: false,
                    errors: ['Duplicate request (nonce already processed)'],
                };
            }

            // Verify trip, driver, and bus exist
            const [trip, driver, bus] = await Promise.all([
                Trip.findOne({ _id: payload.tripId, organizationId }).select('_id status'),
                Driver.findOne({ _id: payload.driverId, organizationId }).select('_id assignedBusId'),
                Bus.findOne({ _id: payload.busId, organizationId }).select('_id'),
            ]);

            if (!trip) {
                errors.push('Trip not found');
                return {
                    success: false,
                    processedCount: 0,
                    validCount: 0,
                    invalidCount: payload.locations.length,
                    duplicateCount: 0,
                    skippedCount: payload.locations.length,
                    cacheUpdated: false,
                    errors,
                };
            }

            if (!driver) {
                errors.push('Driver not found');
                return {
                    success: false,
                    processedCount: 0,
                    validCount: 0,
                    invalidCount: payload.locations.length,
                    duplicateCount: 0,
                    skippedCount: payload.locations.length,
                    cacheUpdated: false,
                    errors,
                };
            }

            if (!bus) {
                errors.push('Bus not found');
                return {
                    success: false,
                    processedCount: 0,
                    validCount: 0,
                    invalidCount: payload.locations.length,
                    duplicateCount: 0,
                    skippedCount: payload.locations.length,
                    cacheUpdated: false,
                    errors,
                };
            }

            // Verify driver is assigned to this bus
            if (String(driver.assignedBusId) !== String(bus._id)) {
                errors.push('Driver not assigned to this bus');
                return {
                    success: false,
                    processedCount: 0,
                    validCount: 0,
                    invalidCount: payload.locations.length,
                    duplicateCount: 0,
                    skippedCount: payload.locations.length,
                    cacheUpdated: false,
                    errors,
                };
            }

            // Get last valid location for duplicate/spoofing detection
            const lastLog = await LocationLog.findOne({
                driverId: payload.driverId,
            })
                .sort({ timestamp: -1 })
                .select('latitude longitude timestamp');

            const lastValid: ValidatedLocation | null = lastLog
                ? {
                    latitude: lastLog.latitude,
                    longitude: lastLog.longitude,
                    timestamp: lastLog.timestamp.toISOString(),
                    validatedAt: lastLog.timestamp,
                }
                : null;

            // Validate and filter locations
            const validation = locationValidationService.validateBatch(payload.locations, lastValid);

            if (validation.validLocations.length === 0) {
                logger.warn(
                    `Batch rejected for driver ${payload.driverId}: no valid locations (invalid: ${validation.invalidLocations.length}, duplicates: ${validation.duplicateCount}, suspicious: ${validation.suspiciousCount})`
                );

                return {
                    success: false,
                    processedCount: 0,
                    validCount: 0,
                    invalidCount: validation.invalidLocations.length,
                    duplicateCount: validation.duplicateCount,
                    skippedCount: validation.duplicateCount + validation.suspiciousCount,
                    cacheUpdated: false,
                    errors: ['No valid locations in batch'],
                };
            }

            // Build bulk insert operations
            const bulkOps = validation.validLocations.map((location) => ({
                insertOne: {
                    document: {
                        organizationId: new mongoose.Types.ObjectId(organizationId),
                        driverId: new mongoose.Types.ObjectId(payload.driverId),
                        busId: new mongoose.Types.ObjectId(payload.busId),
                        tripId: new mongoose.Types.ObjectId(payload.tripId),
                        latitude: location.latitude,
                        longitude: location.longitude,
                        location: {
                            type: 'Point',
                            coordinates: [location.longitude, location.latitude],
                        },
                        speed: location.speed || 0,
                        heading: location.heading || 0,
                        accuracy: location.accuracy,
                        batteryLevel: location.batteryLevel,
                        timestamp: new Date(location.timestamp),
                        recordedAt: new Date(location.timestamp),
                    },
                },
            }));

            // Bulk insert into database
            const insertResult = await LocationLog.collection.bulkWrite(bulkOps, { ordered: false });
            const insertedCount = insertResult.insertedCount;

            // Update Redis cache with latest location
            const latestLocation = validation.validLocations[validation.validLocations.length - 1];

            // DB update log for tracing (after latestLocation is defined)
            console.log('[DB UPDATE]', { busId: payload.busId, tripId: payload.tripId, lat: latestLocation.latitude, lng: latestLocation.longitude, insertedCount });
            const cacheData: CachedLocation = {
                latitude: latestLocation.latitude,
                longitude: latestLocation.longitude,
                speed: latestLocation.speed,
                heading: latestLocation.heading,
                accuracy: latestLocation.accuracy,
                batteryLevel: latestLocation.batteryLevel,
                timestamp: latestLocation.timestamp,
            };

            logger.info('✅ Redis caching calls initiated');

            await Promise.all([
                redisService.cacheDriverLocation(payload.driverId, cacheData),
                redisService.cacheTripLocation(payload.tripId, {
                    latitude: latestLocation.latitude,
                    longitude: latestLocation.longitude,
                    speed: latestLocation.speed,
                    heading: latestLocation.heading,
                    accuracy: latestLocation.accuracy,
                    timestamp: latestLocation.timestamp,
                }),
                redisService.cacheBusLocation(payload.busId, {
                    latitude: latestLocation.latitude,
                    longitude: latestLocation.longitude,
                    speed: latestLocation.speed,
                    heading: latestLocation.heading,
                    accuracy: latestLocation.accuracy,
                    timestamp: latestLocation.timestamp,
                }, payload.tripId),
                redisService.addDriverToGeoIndex(
                    payload.tripId,
                    latestLocation.longitude,
                    latestLocation.latitude,
                    payload.driverId
                ),
            ]);

            logger.info('✅ Redis caching completed', {
                driverId: payload.driverId,
                tripId: payload.tripId,
                busId: payload.busId,
                cachedLatitude: latestLocation.latitude,
                cachedLongitude: latestLocation.longitude,
            });

            console.log('[GPS RECEIVED]', { busId: payload.busId, tripId: payload.tripId, lat: latestLocation.latitude, lng: latestLocation.longitude, timestamp: latestLocation.timestamp });

            // Broadcast location to passengers (normalize to lat/lng)
            broadcastService.broadcastBusLocation(payload.tripId, {
                busId: payload.busId,
                tripId: payload.tripId,
                lat: latestLocation.latitude,
                lng: latestLocation.longitude,
                latitude: latestLocation.latitude,
                longitude: latestLocation.longitude,
                speed: latestLocation.speed,
                heading: latestLocation.heading,
                accuracy: latestLocation.accuracy,
                timestamp: latestLocation.timestamp,
            } as any);

            // Trigger notification pipeline (near-stop, arrived, etc.)
            try {
                const busDoc = await Bus.findById(payload.busId).select('numberPlate').lean();
                await notificationService.processBusLocationUpdate({
                    organizationId,
                    busId: payload.busId,
                    busNumberPlate: busDoc?.numberPlate || 'Unknown',
                    latitude: latestLocation.latitude,
                    longitude: latestLocation.longitude,
                    isBusStartedEvent: false, // Trip start is handled by startTripForDriver
                    timestamp: new Date(latestLocation.timestamp),
                });
            } catch (notifError) {
                logger.warn(`[BatchTracking] Notification processing failed (non-critical): ${notifError instanceof Error ? notifError.message : 'Unknown'}`);
            }

            // Mark nonce as processed
            await redisService.markNonceProcessed(payload.nonce);

            logger.info(
                `Batch processed for driver ${payload.driverId}: inserted=${insertedCount}, invalid=${validation.invalidLocations.length}, duplicates=${validation.duplicateCount}, suspicious=${validation.suspiciousCount}`
            );

            return {
                success: true,
                processedCount: insertedCount,
                validCount: validation.validLocations.length,
                invalidCount: validation.invalidLocations.length,
                duplicateCount: validation.duplicateCount,
                skippedCount: validation.duplicateCount + validation.suspiciousCount,
                cacheUpdated: true,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.error(`Batch processing failed: ${message}`);
            errors.push(message);

            return {
                success: false,
                processedCount: 0,
                validCount: 0,
                invalidCount: payload.locations.length,
                duplicateCount: 0,
                skippedCount: payload.locations.length,
                cacheUpdated: false,
                errors,
            };
        }
    },

    /**
     * Get cached driver location
     */
    async getDriverLocationCache(driverId: string) {
        try {
            return await redisService.getDriverLocation(driverId);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get driver location cache: ${message}`);
            return null;
        }
    },

    /**
     * Get cached trip location (latest bus location on trip)
     */
    async getTripLocationCache(tripId: string) {
        try {
            return await redisService.getTripLocation(tripId);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get trip location cache: ${message}`);
            return null;
        }
    },

    /**
     * Get cached bus location
     */
    async getBusLocationCache(busId: string) {
        try {
            return await redisService.getBusLocation(busId);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get bus location cache: ${message}`);
            return null;
        }
    },
};
