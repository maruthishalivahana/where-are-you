import { Bus } from '../bus/bus.model';
import { Driver } from '../driver/driver.model';
import { LocationLog } from '../locationLog/locationLog.model';
import { TRACKING_EVENTS } from './tracking.events';
import { getBusRoom, getRouteRoom } from '../../websocket/socket.rooms';
import { getIO } from '../../websocket/socket.server';
import { ENV } from '../../config/env.config';
import { calculateDistanceMeters } from '../../utils/calculateDistance';
import { notificationService } from '../notification/notification.service';
import { tripService } from '../trip/trip.service';
import { logger } from '../../utils/logger';
import { Stop } from '../stop/stop.model';
import { Route } from '../route/route.model';
import { buildEtaSnapshot } from '../../utils/eta';

type DriverLocationCacheEntry = {
    driverId: string;
    organizationId: string;
    busId: string;
    latitude: number;
    longitude: number;
    speedMps: number;
    headingDeg: number;
    timestamp: Date;
    lastPersistedAt: Date;
    lastPersistedLat: number;
    lastPersistedLng: number;
    lastRawRequestAt: Date;
    recentRequestCount: number;
};

const driverLocationCache = new Map<string, DriverLocationCacheEntry>();

const DEDUPE_DISTANCE_METERS = 5;
const DEDUPE_TIME_MS = 5_000;
const PERSIST_MIN_DISTANCE_METERS = Math.max(5, ENV.TRACKING_MOVEMENT_THRESHOLD_METERS);
const PERSIST_MIN_TIME_MS = Math.max(5_000, ENV.TRACKING_UPDATE_INTERVAL_MS);
const PREDICTION_IDLE_MS = 12_000;
const PREDICTION_TICK_MS = 4_000;
const MAX_PREDICTION_SPEED_MPS = 35;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_REQUESTS = 25;
const STOP_REACHED_THRESHOLD_METERS = 100;

const lastReachedStopByBus = new Map<string, string>();

const validateCoordinates = (latitude: number, longitude: number): void => {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        throw new Error('latitude must be between -90 and 90');
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new Error('longitude must be between -180 and 180');
    }
};

const toRecordedAt = (value?: Date | string): Date => {
    if (!value) {
        return new Date();
    }

    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error('timestamp must be a valid ISO date string');
    }

    return parsed;
};

const toTelemetrySpeed = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }

    return Math.max(0, value);
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const toHeadingDegrees = (
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number
): number => {
    const dLng = ((toLng - fromLng) * Math.PI) / 180;
    const fromLatRad = (fromLat * Math.PI) / 180;
    const toLatRad = (toLat * Math.PI) / 180;
    const y = Math.sin(dLng) * Math.cos(toLatRad);
    const x =
        Math.cos(fromLatRad) * Math.sin(toLatRad) -
        Math.sin(fromLatRad) * Math.cos(toLatRad) * Math.cos(dLng);
    const bearing = (Math.atan2(y, x) * 180) / Math.PI;

    return (bearing + 360) % 360;
};

const predictNextCoordinate = (params: {
    latitude: number;
    longitude: number;
    headingDeg: number;
    speedMps: number;
    elapsedMs: number;
}): { latitude: number; longitude: number } => {
    const distanceMeters = clamp(params.speedMps, 0, MAX_PREDICTION_SPEED_MPS) *
        Math.max(0, params.elapsedMs / 1000);

    if (distanceMeters <= 0) {
        return { latitude: params.latitude, longitude: params.longitude };
    }

    const headingRad = (params.headingDeg * Math.PI) / 180;
    const deltaNorthMeters = Math.cos(headingRad) * distanceMeters;
    const deltaEastMeters = Math.sin(headingRad) * distanceMeters;

    const deltaLat = deltaNorthMeters / 111_111;
    const latitude = params.latitude + deltaLat;

    const cosLat = Math.cos((params.latitude * Math.PI) / 180);
    const safeCosLat = Math.abs(cosLat) < 0.000001 ? 0.000001 : cosLat;
    const deltaLng = deltaEastMeters / (111_111 * safeCosLat);
    const longitude = params.longitude + deltaLng;

    return {
        latitude: clamp(latitude, -90, 90),
        longitude: clamp(longitude, -180, 180),
    };
};

const buildRealtimePayload = (params: {
    busId: string;
    lat?: number;
    lng?: number;
    speed?: number;
    heading?: number;
    tripStatus: string | null;
    timestamp: Date;
    skipped: boolean;
    isPredicted?: boolean;
}) => ({
    busId: params.busId,
    lat: params.lat,
    lng: params.lng,
    speed: params.speed,
    heading: params.heading,
    status: params.tripStatus,
    timestamp: params.timestamp.toISOString(),
    trackingStatus: params.tripStatus,
    tripStatus: params.tripStatus,
    skipped: params.skipped,
    isPredicted: params.isPredicted === true,
});

const emitBusLocationSafely = (params: {
    busId: string;
    lat?: number;
    lng?: number;
    speed?: number;
    heading?: number;
    tripStatus: string | null;
    timestamp: Date;
    skipped: boolean;
    isPredicted?: boolean;
}) => {
    try {
        const io = getIO();
        io.to(getBusRoom(params.busId)).emit(
            TRACKING_EVENTS.BUS_LOCATION_UPDATE,
            buildRealtimePayload(params)
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : 'socket emit failed';
        logger.warn(`[Tracking] socket emit skipped for bus=${params.busId}: ${message}`);
    }
};

const emitStopUpdateSafely = (params: {
    busId: string;
    routeId: string;
    currentStopId: string;
    nextStopId: string | null;
    timestamp: Date;
    timeline?: {
        currentStop: Record<string, unknown> | null;
        nextStop: Record<string, unknown> | null;
    };
}) => {
    try {
        const io = getIO();
        io.to(getRouteRoom(params.routeId)).emit(TRACKING_EVENTS.STOP_UPDATE, {
            busId: params.busId,
            routeId: params.routeId,
            currentStopId: params.currentStopId,
            nextStopId: params.nextStopId,
            timestamp: params.timestamp.getTime(),
            timeline: params.timeline || null,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'socket emit failed';
        logger.warn(
            `[Tracking] stopUpdate emit skipped for bus=${params.busId} route=${params.routeId}: ${message}`
        );
    }
};

const emitEtaUpdateSafely = (params: {
    busId: string;
    routeId: string;
    timestamp: Date;
    etaSnapshot: Record<string, unknown>;
}) => {
    try {
        const io = getIO();
        io.to(getRouteRoom(params.routeId)).emit(TRACKING_EVENTS.ETA_UPDATE, {
            busId: params.busId,
            routeId: params.routeId,
            timestamp: params.timestamp.getTime(),
            ...params.etaSnapshot,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'socket emit failed';
        logger.warn(
            `[Tracking] etaUpdate emit skipped for bus=${params.busId} route=${params.routeId}: ${message}`
        );
    }
};

const detectStopCrossingAndEmit = async (params: {
    organizationId: string;
    busId: string;
    routeId: string;
    latitude: number;
    longitude: number;
    timestamp: Date;
}) => {
    try {
        const stops = await Stop.find({
            organizationId: params.organizationId,
            routeId: params.routeId,
        })
            .sort({ sequenceOrder: 1 })
            .select('_id name latitude longitude sequenceOrder radiusMeters');

        if (stops.length === 0) {
            return;
        }

        let nearestIndex = -1;
        let nearestDistanceMeters = Number.POSITIVE_INFINITY;

        for (let index = 0; index < stops.length; index += 1) {
            const stop = stops[index];
            const distanceMeters = calculateDistanceMeters(
                params.latitude,
                params.longitude,
                stop.latitude,
                stop.longitude
            );

            if (distanceMeters < nearestDistanceMeters) {
                nearestDistanceMeters = distanceMeters;
                nearestIndex = index;
            }
        }

        if (nearestIndex < 0 || nearestDistanceMeters >= STOP_REACHED_THRESHOLD_METERS) {
            return;
        }

        const currentStopId = String(stops[nearestIndex]._id);
        const previousStopId = lastReachedStopByBus.get(params.busId);
        if (previousStopId === currentStopId) {
            return;
        }

        lastReachedStopByBus.set(params.busId, currentStopId);

        const nextStop = stops[nearestIndex + 1];
        const route = await Route.findOne({
            _id: params.routeId,
            organizationId: params.organizationId,
        }).select('totalDistanceMeters estimatedDurationSeconds endLat endLng polyline encodedPolyline timezone');

        const eta = route
            ? buildEtaSnapshot({
                current: {
                    latitude: params.latitude,
                    longitude: params.longitude,
                },
                route: {
                    totalDistanceMeters: route.totalDistanceMeters,
                    estimatedDurationSeconds: route.estimatedDurationSeconds,
                    endLat: route.endLat,
                    endLng: route.endLng,
                    polyline: route.polyline || route.encodedPolyline,
                    timezone: (route as any).timezone || ENV.TRACKING_TIMEZONE,
                },
                stops: stops.map((stop) => ({
                    id: String(stop._id),
                    name: stop.name,
                    latitude: stop.latitude,
                    longitude: stop.longitude,
                    sequenceOrder: stop.sequenceOrder,
                    radiusMeters: stop.radiusMeters,
                })),
            })
            : null;

        const currentStopTimeline = eta?.stopsWithEta.find((stop) => stop.id === currentStopId) || null;
        const nextStopTimeline = nextStop
            ? eta?.stopsWithEta.find((stop) => stop.id === String(nextStop._id)) || null
            : null;

        emitStopUpdateSafely({
            busId: params.busId,
            routeId: params.routeId,
            currentStopId,
            nextStopId: nextStop ? String(nextStop._id) : null,
            timestamp: params.timestamp,
            timeline: {
                currentStop: currentStopTimeline,
                nextStop: nextStopTimeline,
            },
        });

        if (eta) {
            emitEtaUpdateSafely({
                busId: params.busId,
                routeId: params.routeId,
                timestamp: params.timestamp,
                etaSnapshot: {
                    etaToDestinationSeconds: eta.etaToDestinationSeconds,
                    etaToDestinationText: eta.etaToDestinationText,
                    averageSpeedKmph: eta.averageSpeedKmph,
                    stops: eta.stopsWithEta,
                },
            });
        }

        logger.info(
            `[Tracking] stop reached bus=${params.busId} route=${params.routeId} stop=${currentStopId} distance=${Math.round(nearestDistanceMeters)}m`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : 'stop crossing detection failed';
        logger.warn(
            `[Tracking] stop crossing detection failed bus=${params.busId} route=${params.routeId}: ${message}`
        );
    }
};

const startPredictionLoop = () => {
    setInterval(() => {
        const nowMs = Date.now();

        for (const cacheEntry of driverLocationCache.values()) {
            const elapsedMs = nowMs - cacheEntry.timestamp.getTime();
            if (elapsedMs < PREDICTION_IDLE_MS) {
                continue;
            }

            const predicted = predictNextCoordinate({
                latitude: cacheEntry.latitude,
                longitude: cacheEntry.longitude,
                headingDeg: cacheEntry.headingDeg,
                speedMps: cacheEntry.speedMps,
                elapsedMs,
            });

            const predictedAt = new Date(nowMs);
            cacheEntry.latitude = predicted.latitude;
            cacheEntry.longitude = predicted.longitude;
            cacheEntry.timestamp = predictedAt;

            emitBusLocationSafely({
                busId: cacheEntry.busId,
                lat: predicted.latitude,
                lng: predicted.longitude,
                speed: cacheEntry.speedMps,
                heading: cacheEntry.headingDeg,
                tripStatus: null,
                timestamp: predictedAt,
                skipped: false,
                isPredicted: true,
            });

            logger.info(
                `[Tracking] predicted location broadcast driver=${cacheEntry.driverId} bus=${cacheEntry.busId}`
            );
        }
    }, PREDICTION_TICK_MS).unref();
};

startPredictionLoop();

export const trackingService = {
    updateBusLocation: async (
        busId: string,
        latitude: number,
        longitude: number,
        speed?: number,
        timestamp?: Date | string
    ) => {
        const bus = await Bus.findById(busId).select('_id organizationId driverId');
        if (!bus) {
            throw new Error('Bus not found');
        }

        if (!bus.driverId) {
            throw new Error('No driver assigned to this bus');
        }

        return trackingService.updateMyBusLocation(
            String(bus.driverId),
            String(bus.organizationId),
            latitude,
            longitude,
            speed,
            timestamp
        );
    },

    updateMyBusLocation: async (
        driverId: string,
        organizationId: string,
        latitude: number,
        longitude: number,
        speed?: number,
        timestamp?: Date | string,
        heading?: number
    ) => {
        validateCoordinates(latitude, longitude);

        const recordedAt = toRecordedAt(timestamp);
        logger.debug(`[Tracking] location received driver=${driverId} org=${organizationId}`);

        const driver = await Driver.findOne({ _id: driverId, organizationId });

        if (!driver) {
            throw new Error('Driver not found');
        }

        if (!driver.assignedBusId) {
            throw new Error('No bus assigned to this driver');
        }

        const bus = await Bus.findOne({ _id: driver.assignedBusId, organizationId });

        if (!bus) {
            throw new Error('Assigned bus not found');
        }

        const cached = driverLocationCache.get(driverId);
        const now = recordedAt;

        if (cached) {
            const requestWindowMs = now.getTime() - cached.lastRawRequestAt.getTime();
            if (requestWindowMs <= RATE_LIMIT_WINDOW_MS) {
                cached.recentRequestCount += 1;
            } else {
                cached.recentRequestCount = 1;
            }
            cached.lastRawRequestAt = now;
        }

        const hasPreviousLocation =
            typeof bus.currentLat === 'number' &&
            typeof bus.currentLng === 'number' &&
            Number.isFinite(bus.currentLat) &&
            Number.isFinite(bus.currentLng);

        const previousLatitude = hasPreviousLocation ? bus.currentLat : undefined;
        const previousLongitude = hasPreviousLocation ? bus.currentLng : undefined;

        const previousTimestamp = bus.lastUpdated ? new Date(bus.lastUpdated).getTime() : null;
        const elapsedMs = previousTimestamp
            ? Math.max(0, recordedAt.getTime() - previousTimestamp)
            : Number.MAX_SAFE_INTEGER;
        const movedMeters =
            hasPreviousLocation &&
                typeof previousLatitude === 'number' &&
                typeof previousLongitude === 'number'
                ? calculateDistanceMeters(previousLatitude, previousLongitude, latitude, longitude)
                : Number.MAX_SAFE_INTEGER;

        if (hasPreviousLocation && movedMeters === 0) {
            logger.info(`[Tracking] skipped duplicate point driver=${driverId} bus=${String(bus._id)}`);
            return {
                busId: String(bus._id),
                lat: bus.currentLat,
                lng: bus.currentLng,
                speed: bus.currentSpeedMps,
                status: null,
                timestamp: recordedAt.toISOString(),
                latitude: bus.currentLat,
                longitude: bus.currentLng,
                recordedAt: bus.lastUpdated,
                trackingStatus: null,
                tripStatus: null,
                activeTrip: null,
                skipped: true,
                reason: 'duplicate',
            };
        }

        if (hasPreviousLocation && movedMeters < DEDUPE_DISTANCE_METERS && elapsedMs < DEDUPE_TIME_MS) {
            logger.info(`[Tracking] skipped noisy near-duplicate driver=${driverId} bus=${String(bus._id)}`);
            return {
                busId: String(bus._id),
                lat: bus.currentLat,
                lng: bus.currentLng,
                speed: bus.currentSpeedMps,
                status: null,
                timestamp: recordedAt.toISOString(),
                latitude: bus.currentLat,
                longitude: bus.currentLng,
                recordedAt: bus.lastUpdated,
                trackingStatus: null,
                tripStatus: null,
                activeTrip: null,
                skipped: true,
                reason: 'near_duplicate',
            };
        }

        const rateLimited =
            !!cached &&
            cached.recentRequestCount > RATE_LIMIT_MAX_REQUESTS &&
            movedMeters < PERSIST_MIN_DISTANCE_METERS;

        if (rateLimited) {
            logger.warn(`[Tracking] rate-limited noisy burst driver=${driverId} bus=${String(bus._id)}`);
            return {
                busId: String(bus._id),
                lat: bus.currentLat,
                lng: bus.currentLng,
                speed: bus.currentSpeedMps,
                status: null,
                timestamp: recordedAt.toISOString(),
                latitude: bus.currentLat,
                longitude: bus.currentLng,
                recordedAt: bus.lastUpdated,
                trackingStatus: null,
                tripStatus: null,
                activeTrip: null,
                skipped: true,
                reason: 'rate_limited',
            };
        }

        // Lightweight smoothing to reduce GPS jitter while preserving direction.
        const smoothedLatitude = hasPreviousLocation && typeof previousLatitude === 'number'
            ? (previousLatitude + latitude) / 2
            : latitude;
        const smoothedLongitude = hasPreviousLocation && typeof previousLongitude === 'number'
            ? (previousLongitude + longitude) / 2
            : longitude;

        const movedAfterSmoothing =
            hasPreviousLocation && typeof previousLatitude === 'number' && typeof previousLongitude === 'number'
                ? calculateDistanceMeters(previousLatitude, previousLongitude, smoothedLatitude, smoothedLongitude)
                : Number.MAX_SAFE_INTEGER;

        const shouldUpdate =
            !hasPreviousLocation ||
            elapsedMs >= ENV.TRACKING_UPDATE_INTERVAL_MS ||
            movedAfterSmoothing >= ENV.TRACKING_MOVEMENT_THRESHOLD_METERS;

        if (!shouldUpdate) {
            const activeTrip = await tripService.getActiveTripByDriverId(driverId, organizationId);
            if (!activeTrip) {
                throw new Error('No active trip found for this driver');
            }
            const tripStatus = activeTrip?.status || null;

            return {
                busId: String(bus._id),
                lat: bus.currentLat,
                lng: bus.currentLng,
                speed: bus.currentSpeedMps,
                status: tripStatus,
                timestamp: recordedAt.toISOString(),
                latitude: bus.currentLat,
                longitude: bus.currentLng,
                recordedAt: bus.lastUpdated,
                trackingStatus: tripStatus,
                tripStatus,
                activeTrip,
                skipped: true,
                reason: 'throttled',
                nextAllowedInMs: Math.max(0, ENV.TRACKING_UPDATE_INTERVAL_MS - elapsedMs),
            };
        }

        const computedSpeedMps =
            hasPreviousLocation && elapsedMs > 0
                ? movedAfterSmoothing / Math.max(1, elapsedMs / 1000)
                : 0;
        const speedMps = toTelemetrySpeed(speed) ?? computedSpeedMps;
        const headingDeg = typeof heading === 'number' && Number.isFinite(heading)
            ? (heading + 360) % 360
            : hasPreviousLocation && typeof previousLatitude === 'number' && typeof previousLongitude === 'number'
                ? toHeadingDegrees(previousLatitude, previousLongitude, smoothedLatitude, smoothedLongitude)
                : 0;

        const tripUpdate = await tripService.updateActiveTripLocationByDriver(
            driverId,
            organizationId,
            { lat: smoothedLatitude, lng: smoothedLongitude },
            speedMps,
            recordedAt
        );

        const baselineLat = cached?.lastPersistedLat ?? previousLatitude;
        const baselineLng = cached?.lastPersistedLng ?? previousLongitude;
        const baselineTs = cached?.lastPersistedAt ?? (bus.lastUpdated ? new Date(bus.lastUpdated) : undefined);
        const persistMovedMeters =
            typeof baselineLat === 'number' && typeof baselineLng === 'number'
                ? calculateDistanceMeters(baselineLat, baselineLng, smoothedLatitude, smoothedLongitude)
                : Number.MAX_SAFE_INTEGER;
        const persistElapsedMs = baselineTs
            ? Math.max(0, recordedAt.getTime() - baselineTs.getTime())
            : Number.MAX_SAFE_INTEGER;
        const shouldPersistLog =
            !baselineTs ||
            persistMovedMeters >= PERSIST_MIN_DISTANCE_METERS ||
            persistElapsedMs >= PERSIST_MIN_TIME_MS;

        if (shouldPersistLog) {
            await LocationLog.create({
                organizationId: bus.organizationId,
                busId: bus._id,
                latitude: smoothedLatitude,
                longitude: smoothedLongitude,
                recordedAt,
            });
        }

        await notificationService.processBusLocationUpdate({
            organizationId: String(bus.organizationId),
            busId: String(bus._id),
            busNumberPlate: bus.numberPlate,
            latitude: smoothedLatitude,
            longitude: smoothedLongitude,
            isBusStartedEvent: tripUpdate.isBusStartedEvent,
        });

        emitBusLocationSafely({
            busId: String(bus._id),
            lat: smoothedLatitude,
            lng: smoothedLongitude,
            speed: speedMps,
            heading: headingDeg,
            tripStatus: tripUpdate.trip.status,
            timestamp: recordedAt,
            skipped: false,
            isPredicted: false,
        });

        if (bus.routeId) {
            await detectStopCrossingAndEmit({
                organizationId,
                busId: String(bus._id),
                routeId: String(bus.routeId),
                latitude: smoothedLatitude,
                longitude: smoothedLongitude,
                timestamp: recordedAt,
            });
        }

        driverLocationCache.set(driverId, {
            driverId,
            organizationId,
            busId: String(bus._id),
            latitude: smoothedLatitude,
            longitude: smoothedLongitude,
            speedMps,
            headingDeg,
            timestamp: recordedAt,
            lastPersistedAt: shouldPersistLog ? recordedAt : (cached?.lastPersistedAt || recordedAt),
            lastPersistedLat: shouldPersistLog ? smoothedLatitude : (cached?.lastPersistedLat ?? smoothedLatitude),
            lastPersistedLng: shouldPersistLog ? smoothedLongitude : (cached?.lastPersistedLng ?? smoothedLongitude),
            lastRawRequestAt: recordedAt,
            recentRequestCount: cached ? cached.recentRequestCount : 1,
        });

        logger.info(
            `[Tracking] stored location driver=${driverId} bus=${String(bus._id)} persisted=${shouldPersistLog}`
        );

        return {
            busId: String(bus._id),
            lat: smoothedLatitude,
            lng: smoothedLongitude,
            speed: speedMps,
            status: tripUpdate.trip.status,
            timestamp: recordedAt.toISOString(),
            latitude: smoothedLatitude,
            longitude: smoothedLongitude,
            recordedAt,
            trackingStatus: tripUpdate.trip.status,
            tripStatus: tripUpdate.trip.status,
            activeTrip: tripUpdate.trip,
            skipped: false,
            heading: headingDeg,
            isPredicted: false,
            persisted: shouldPersistLog,
        };
    },

    /**
     * Get last recorded location for a driver from database
     */
    async getLastDriverLocation(driverId: string) {
        try {
            const lastLog = await LocationLog.findOne({ driverId }).sort({ timestamp: -1 }).lean();
            return lastLog;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get last driver location: ${message}`);
            return null;
        }
    },

    /**
     * Get last recorded location for a trip from database
     */
    async getLastTripLocation(tripId: string) {
        try {
            const lastLog = await LocationLog.findOne({ tripId }).sort({ timestamp: -1 }).lean();
            return lastLog;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get last trip location: ${message}`);
            return null;
        }
    },

    /**
     * Get last recorded location for a bus from database
     */
    async getLastBusLocation(busId: string) {
        try {
            const lastLog = await LocationLog.findOne({ busId }).sort({ timestamp: -1 }).lean();
            return lastLog;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to get last bus location: ${message}`);
            return null;
        }
    },
};
