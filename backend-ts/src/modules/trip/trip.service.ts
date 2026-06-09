import { Trip } from './trip.model';
import { Driver } from '../driver/driver.model';
import { Bus } from '../bus/bus.model';
import {
    ACTIVE_TRIP_TERMINAL_STATUSES,
    TRIP_STATUS,
    TripStatus,
} from '../../constants/tripStatus';
import { notificationService } from '../notification/notification.service';
import { logger } from '../../utils/logger';

const ACTIVE_TRIP_QUERY = {
    $nin: ACTIVE_TRIP_TERMINAL_STATUSES,
};

type TripPayload = {
    id: string;
    status: string;
    startedAt: Date | null;
    endedAt: Date | null;
    currentLocation: { lat: number; lng: number } | null;
    createdAt: Date;
    updatedAt: Date;
    driverId: string;
    busId: string;
    routeId: string;
    bus: { id: string; numberPlate: string } | null;
    route: { id: string; name: string; startName: string; endName: string } | null;
};

const mapTrip = (trip: any): TripPayload | null => {
    if (!trip) {
        return null;
    }

    const bus = trip.busId as any;
    const route = trip.routeId as any;
    const driver = trip.driverId as any;

    return {
        id: String(trip._id),
        status: trip.status,
        startedAt: trip.startedAt || null,
        endedAt: trip.endedAt || null,
        currentLocation: trip.currentLocation || null,
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
        driverId: driver?._id ? String(driver._id) : String(trip.driverId),
        busId: bus?._id ? String(bus._id) : String(trip.busId),
        routeId: route?._id ? String(route._id) : String(trip.routeId),
        bus: bus
            ? {
                id: String(bus._id),
                numberPlate: bus.numberPlate,
            }
            : null,
        route: route
            ? {
                id: String(route._id),
                name: route.name,
                startName: route.startName,
                endName: route.endName,
            }
            : null,
    };
};

const mapTripOrThrow = (trip: any): TripPayload => {
    const mapped = mapTrip(trip);
    if (!mapped) {
        throw new Error('Trip not found');
    }

    return mapped;
};

export const tripService = {
    mapTrip,

    getActiveTripByDriverId: async (driverId: string, organizationId: string) => {
        const trip = await Trip.findOne({
            organizationId,
            driverId,
            status: ACTIVE_TRIP_QUERY,
        })
            .sort({ createdAt: -1 })
            .populate('busId', 'numberPlate')
            .populate('routeId', 'name startName endName')
            .populate('driverId', 'name memberId');

        return mapTrip(trip);
    },

    getActiveTripByBusId: async (busId: string, organizationId: string) => {
        const trip = await Trip.findOne({
            organizationId,
            busId,
            status: ACTIVE_TRIP_QUERY,
        })
            .sort({ createdAt: -1 })
            .populate('busId', 'numberPlate')
            .populate('routeId', 'name startName endName')
            .populate('driverId', 'name memberId');

        return mapTrip(trip);
    },

    getActiveTripByBusIds: async (organizationId: string, busIds: string[]) => {
        if (busIds.length === 0) {
            return new Map<string, any>();
        }

        const trips = await Trip.find({
            organizationId,
            busId: { $in: busIds },
            status: ACTIVE_TRIP_QUERY,
        })
            .sort({ createdAt: -1 })
            .populate('busId', 'numberPlate')
            .populate('routeId', 'name startName endName');

        const latestByBus = new Map<string, any>();
        for (const trip of trips) {
            const busId = String((trip.busId as any)?._id || trip.busId);
            if (!latestByBus.has(busId)) {
                latestByBus.set(busId, mapTrip(trip));
            }
        }

        return latestByBus;
    },

    startTripForDriver: async (driverId: string, organizationId: string) => {
        const driver = await Driver.findOne({ _id: driverId, organizationId });
        if (!driver) {
            throw new Error('Driver not found');
        }

        if (!driver.assignedBusId) {
            throw new Error('No bus assigned to this driver');
        }

        const bus = await Bus.findOne({
            _id: driver.assignedBusId,
            organizationId,
        }).populate('routeId', 'name startName endName');

        if (!bus) {
            throw new Error('Assigned bus not found');
        }

        if (!bus.routeId) {
            throw new Error('Cannot start trip because no route is assigned to this bus. Assign a route first.');
        }

        const existingActiveTrip = await Trip.findOne({
            organizationId,
            driverId,
            status: ACTIVE_TRIP_QUERY,
        }).sort({ createdAt: -1 });
        if (existingActiveTrip) {
            throw new Error('An active trip already exists for this driver');
        }

        const now = new Date();

        const trip = await Trip.create({
            organizationId,
            driverId: driver._id,
            busId: bus._id,
            routeId: (bus.routeId as any)._id || bus.routeId,
            status: TRIP_STATUS.STARTED,
            startedAt: now,
            currentLocation:
                typeof bus.currentLat === 'number' && typeof bus.currentLng === 'number'
                    ? {
                        lat: bus.currentLat,
                        lng: bus.currentLng,
                    }
                    : undefined,
        });

        driver.isTracking = true;
        await driver.save();

        bus.lastUpdated = now;
        await bus.save();

        const populatedTrip = await Trip.findById(trip._id)
            .populate('busId', 'numberPlate')
            .populate('routeId', 'name startName endName')
            .populate('driverId', 'name memberId');

        const result = mapTripOrThrow(populatedTrip);

        // Emit trip started notification
        try {
            const busData = populatedTrip?.busId as any;
            const routeData = populatedTrip?.routeId as any;
            await notificationService.handleTripStarted({
                organizationId: String(organizationId),
                busId: String(bus._id),
                busNumberPlate: busData?.numberPlate || bus.numberPlate || 'Unknown',
                tripId: result.id,
                routeId: routeData?._id ? String(routeData._id) : String(bus.routeId),
            });
        } catch (error) {
            logger.error('[TripService] Failed to emit trip started notification:', error);
        }

        return result;
    },

    completeActiveTripForDriver: async (
        driverId: string,
        organizationId: string,
        status: TripStatus = TRIP_STATUS.COMPLETED
    ) => {
        const activeTrip = await Trip.findOne({
            organizationId,
            driverId,
            status: ACTIVE_TRIP_QUERY,
        }).sort({ createdAt: -1 });
        if (!activeTrip) {
            return null;
        }

        const now = new Date();
        activeTrip.status = status;
        activeTrip.endedAt = now;
        await activeTrip.save();

        await Driver.findOneAndUpdate(
            { _id: driverId, organizationId },
            { isTracking: false }
        );

        await Bus.findOneAndUpdate(
            { _id: activeTrip.busId, organizationId },
            { lastUpdated: now }
        );

        const populatedTrip = await Trip.findById(activeTrip._id)
            .populate('busId', 'numberPlate')
            .populate('routeId', 'name startName endName')
            .populate('driverId', 'name memberId');

        const result = mapTripOrThrow(populatedTrip);

        // Emit trip completed notification
        try {
            const busData = populatedTrip?.busId as any;
            const routeData = populatedTrip?.routeId as any;
            await notificationService.handleTripCompleted({
                organizationId: String(organizationId),
                busId: String(activeTrip.busId),
                busNumberPlate: busData?.numberPlate || 'Unknown',
                tripId: result.id,
                routeId: routeData?._id ? String(routeData._id) : String(activeTrip.routeId || ''),
            });
        } catch (error) {
            logger.error('[TripService] Failed to emit trip completed notification:', error);
        }

        return result;
    },

    updateActiveTripLocationByDriver: async (
        driverId: string,
        organizationId: string,
        location: { lat: number; lng: number },
        speed: number,
        timestamp: Date
    ) => {
        const trip = await Trip.findOne({
            organizationId,
            driverId,
            status: ACTIVE_TRIP_QUERY,
        }).sort({ createdAt: -1 });
        if (!trip) {
            throw new Error('No active trip found for this driver');
        }

        const nextStatus = speed > 5 ? TRIP_STATUS.RUNNING : TRIP_STATUS.STOPPED;
        const wasRunning = trip.status === TRIP_STATUS.RUNNING;

        if (trip.status !== nextStatus) {
            trip.status = nextStatus;
        }

        if (!trip.startedAt) {
            trip.startedAt = timestamp;
        }

        trip.currentLocation = {
            lat: location.lat,
            lng: location.lng,
        };

        await trip.save();

        await Bus.findOneAndUpdate(
            { _id: trip.busId, organizationId },
            {
                currentLat: location.lat,
                currentLng: location.lng,
                currentSpeedMps: speed,
                lastUpdated: timestamp,
            }
        );

        return {
            trip: mapTripOrThrow(trip),
            isBusStartedEvent: !wasRunning && nextStatus === TRIP_STATUS.RUNNING,
        };
    },
};
