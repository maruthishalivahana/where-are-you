import { Driver } from './driver.model';
import { Bus } from '../bus/bus.model';
import { Route } from '../route/route.model';
import { Stop } from '../stop/stop.model';
import { buildEtaSnapshot } from '../../utils/eta';
import { calculateDistanceMeters } from '../../utils/calculateDistance';
import { logger } from '../../utils/logger';
import { tripService } from '../trip/trip.service';
import { hashPassword } from '../../utils/hashPassword';
import { ENV } from '../../config/env.config';

const formatBusSnapshot = (bus: any, activeTrip: any) => {
    if (!bus) {
        return null;
    }

    const routeRef = bus.routeId as any;
    const routeId = routeRef ? String(routeRef._id || routeRef) : null;
    const routeName = routeRef && typeof routeRef.name === 'string' ? routeRef.name : null;

    return {
        id: String(bus._id),
        numberPlate: bus.numberPlate,
        routeId,
        routeName,
        status: bus.status,
        currentLat: bus.currentLat,
        currentLng: bus.currentLng,
        currentSpeedMps: bus.currentSpeedMps,
        lastUpdated: bus.lastUpdated,
        tripStatus: activeTrip?.status || null,
        activeTrip: activeTrip || null,
    };
};

const buildNoBusAssignedMessage = (driver: { memberId?: string }) =>
    `No bus assigned to this driver. Ask admin to assign a bus to memberId '${driver.memberId || 'unknown'}'.`;

const formatRouteSnapshot = (route: any) => {
    if (!route) {
        return null;
    }

    return {
        id: String(route._id),
        name: route.name,
        startName: route.startName,
        endName: route.endName,
        startLat: route.startLat,
        startLng: route.startLng,
        endLat: route.endLat,
        endLng: route.endLng,
        totalDistanceMeters: route.totalDistanceMeters,
        estimatedDurationSeconds: route.estimatedDurationSeconds,
        isActive: route.isActive,
    };
};

const resolveRouteForBus = async (bus: any, organizationId: any) => {
    if (!bus?.routeId) {
        return null;
    }

    const routeRef = bus.routeId as any;
    if (routeRef && typeof routeRef === 'object' && routeRef._id) {
        return routeRef;
    }

    return Route.findOne({ _id: routeRef, organizationId });
};

const resolveAssignedBusForDriver = async (driver: any) => {
    if (!driver) {
        return null;
    }

    if (driver.assignedBusId) {
        const assignedBus = await Bus.findOne({
            _id: driver.assignedBusId,
            organizationId: driver.organizationId,
        }).populate(
            'routeId',
            'name startName endName startLat startLng endLat endLng totalDistanceMeters estimatedDurationSeconds isActive'
        );

        if (assignedBus) {
            return assignedBus;
        }
    }

    const busByDriver = await Bus.findOne({
        organizationId: driver.organizationId,
        driverId: driver._id,
    })
        .populate(
            'routeId',
            'name startName endName startLat startLng endLat endLng totalDistanceMeters estimatedDurationSeconds isActive'
        )
        .sort({ lastUpdated: -1 });

    if (busByDriver && (!driver.assignedBusId || String(driver.assignedBusId) !== String(busByDriver._id))) {
        driver.assignedBusId = busByDriver._id;
        await driver.save();
    }

    return busByDriver;
};

export const driverService = {
    listDriversByOrganization: async (organizationId: string, search?: string) => {
        const query = search?.trim();
        const drivers = await Driver.find({
            organizationId,
            ...(query
                ? {
                    $or: [
                        { name: { $regex: query, $options: 'i' } },
                        { memberId: { $regex: query, $options: 'i' } },
                        { email: { $regex: query, $options: 'i' } },
                        { phone: { $regex: query, $options: 'i' } },
                    ],
                }
                : {}),
        })
            .select('_id name memberId email phone assignedBusId')
            .sort({ name: 1 });

        return drivers.map((driver) => ({
            id: String(driver._id),
            name: driver.name,
            memberId: driver.memberId,
            email: driver.email || null,
            phone: driver.phone || null,
            assignedBusId: driver.assignedBusId ? String(driver.assignedBusId) : null,
        }));
    },

    updateDriverByAdmin: async (
        organizationId: string,
        driverId: string,
        input: { name?: string; memberId?: string; email?: string; phone?: string; password?: string }
    ) => {
        const driver = await Driver.findOne({ _id: driverId, organizationId });

        if (!driver) {
            throw new Error('Driver not found');
        }

        if (input.memberId && input.memberId !== driver.memberId) {
            const duplicate = await Driver.findOne({
                organizationId,
                memberId: input.memberId,
                _id: { $ne: driverId },
            });

            if (duplicate) {
                throw new Error('memberId already in use');
            }
        }

        const normalizedEmail = input.email?.trim().toLowerCase();
        if (normalizedEmail && normalizedEmail !== driver.email) {
            const duplicate = await Driver.findOne({
                organizationId,
                email: normalizedEmail,
                _id: { $ne: driverId },
            });
            if (duplicate) {
                throw new Error('email already in use');
            }
        }

        const normalizedPhone = input.phone?.trim();
        if (normalizedPhone && normalizedPhone !== driver.phone) {
            const duplicate = await Driver.findOne({
                organizationId,
                phone: normalizedPhone,
                _id: { $ne: driverId },
            });
            if (duplicate) {
                throw new Error('phone already in use');
            }
        }

        const updates: Record<string, unknown> = {};
        if (input.name) updates.name = input.name.trim();
        if (input.memberId) updates.memberId = input.memberId.trim();
        if (input.email !== undefined) updates.email = normalizedEmail || null;
        if (input.phone !== undefined) updates.phone = normalizedPhone || null;
        if (input.password) updates.passwordHash = await hashPassword(input.password);

        const updated = await Driver.findByIdAndUpdate(driverId, { $set: updates }, { new: true });

        return {
            id: String(updated!._id),
            name: updated!.name,
            memberId: updated!.memberId,
            email: updated!.email || null,
            phone: updated!.phone || null,
            assignedBusId: updated!.assignedBusId ? String(updated!.assignedBusId) : null,
        };
    },

    deleteDriverByAdmin: async (organizationId: string, driverId: string) => {
        const driver = await Driver.findOneAndDelete({ _id: driverId, organizationId });

        if (!driver) {
            throw new Error('Driver not found');
        }

        await Bus.updateMany(
            { organizationId, driverId: driver._id },
            { $set: { driverId: null } }
        );

        return { message: 'Driver deleted successfully' };
    },

    getMyDetails: async (driverId: string, organizationId: string) => {
        const driver = await Driver.findOne({ _id: driverId, organizationId });

        if (!driver) {
            throw new Error('Driver not found');
        }

        const assignedBus = await resolveAssignedBusForDriver(driver);
        const activeTrip = assignedBus
            ? await tripService.getActiveTripByBusId(String(assignedBus._id), String(driver.organizationId))
            : null;
        const assignedRoute = formatRouteSnapshot(await resolveRouteForBus(assignedBus, driver.organizationId));

        logger.info('[DriverDashboard] Driver details requested', {
            driverId: String(driver._id),
            memberId: driver.memberId,
            organizationId: String(driver.organizationId),
            assignedBusId: assignedBus ? String(assignedBus._id) : null,
            assignedRouteId: assignedRoute?.id || null,
            activeTripId: activeTrip?.id || null,
        });

        const busSnapshot = formatBusSnapshot(assignedBus, activeTrip);

        return {
            id: String(driver._id),
            name: driver.name,
            memberId: driver.memberId,
            email: driver.email || null,
            phone: driver.phone || null,
            organizationId: String(driver.organizationId),
            assignedBus: busSnapshot,
            bus: busSnapshot,
            assignedRoute,
            route: assignedRoute,
            activeTrip,
        };
    },

    getMyBus: async (driverId: string, organizationId: string) => {
        const driver = await Driver.findOne({ _id: driverId, organizationId });

        if (!driver) {
            throw new Error('Driver not found');
        }

        const bus = await resolveAssignedBusForDriver(driver);

        if (!bus) {
            logger.warn('[DriverDashboard] No bus found for driver', {
                driverId: String(driver._id),
                memberId: driver.memberId,
                organizationId: String(driver.organizationId),
                assignedBusId: driver.assignedBusId ? String(driver.assignedBusId) : null,
            });
            throw new Error(buildNoBusAssignedMessage(driver));
        }

        const activeTrip = await tripService.getActiveTripByBusId(String(bus._id), String(driver.organizationId));
        return formatBusSnapshot(bus, activeTrip);
    },

    getMyRoute: async (driverId: string, organizationId: string) => {
        const driver = await Driver.findOne({ _id: driverId, organizationId });

        if (!driver) {
            throw new Error('Driver not found');
        }

        const bus = await resolveAssignedBusForDriver(driver);

        if (!bus) {
            logger.warn('[DriverDashboard] No bus found while loading route', {
                driverId: String(driver._id),
                memberId: driver.memberId,
                organizationId: String(driver.organizationId),
                assignedBusId: driver.assignedBusId ? String(driver.assignedBusId) : null,
            });
            throw new Error(buildNoBusAssignedMessage(driver));
        }

        const busRouteId = (bus.routeId as any)?._id || bus.routeId;
        if (!busRouteId) {
            throw new Error('No route assigned to this bus');
        }

        const route = await Route.findOne({
            _id: busRouteId,
            organizationId: driver.organizationId,
        });

        if (!route) {
            throw new Error('Route not found');
        }

        const stops = await Stop.find({
            organizationId: driver.organizationId,
            routeId: route._id,
        }).sort({ sequenceOrder: 1 });

        const normalizedStops = stops.map((stop) => ({
            id: String(stop._id),
            name: stop.name,
            latitude: stop.latitude,
            longitude: stop.longitude,
            sequenceOrder: stop.sequenceOrder,
            radiusMeters: stop.radiusMeters,
        }));

        const START_END_MERGE_RADIUS_METERS = 120;
        const hasStartStop = normalizedStops.some(
            (stop) =>
                calculateDistanceMeters(stop.latitude, stop.longitude, route.startLat, route.startLng) <=
                START_END_MERGE_RADIUS_METERS
        );
        const hasEndStop = normalizedStops.some(
            (stop) =>
                calculateDistanceMeters(stop.latitude, stop.longitude, route.endLat, route.endLng) <=
                START_END_MERGE_RADIUS_METERS
        );

        const firstSequence = normalizedStops.length > 0 ? normalizedStops[0].sequenceOrder : 1;
        const lastSequence =
            normalizedStops.length > 0
                ? normalizedStops[normalizedStops.length - 1].sequenceOrder
                : firstSequence + 1;

        const stopsForEta = [...normalizedStops];

        if (!hasStartStop) {
            stopsForEta.push({
                id: `start-${String(route._id)}`,
                name: route.startName || 'Start',
                latitude: route.startLat,
                longitude: route.startLng,
                sequenceOrder: firstSequence - 1,
                radiusMeters: 100,
            });
        }

        if (!hasEndStop) {
            stopsForEta.push({
                id: `end-${String(route._id)}`,
                name: route.endName || 'Destination',
                latitude: route.endLat,
                longitude: route.endLng,
                sequenceOrder: lastSequence + 1,
                radiusMeters: 100,
            });
        }

        const hasLiveCoordinates =
            typeof bus.currentLat === 'number' &&
            typeof bus.currentLng === 'number' &&
            Number.isFinite(bus.currentLat) &&
            Number.isFinite(bus.currentLng) &&
            (bus.currentLat !== 0 || bus.currentLng !== 0);

        const eta = buildEtaSnapshot({
            current: {
                latitude: hasLiveCoordinates ? bus.currentLat! : route.startLat,
                longitude: hasLiveCoordinates ? bus.currentLng! : route.startLng,
            },
            route: {
                totalDistanceMeters: route.totalDistanceMeters,
                estimatedDurationSeconds: route.estimatedDurationSeconds,
                endLat: route.endLat,
                endLng: route.endLng,
                polyline: route.polyline || route.encodedPolyline,
                timezone: (route as any).timezone || ENV.TRACKING_TIMEZONE,
            },
            stops: stopsForEta,
        });

        return {
            bus: {
                id: String(bus._id),
                numberPlate: bus.numberPlate,
            },
            route: {
                id: String(route._id),
                name: route.name,
                encodedPolyline: route.encodedPolyline,
                totalDistanceMeters: route.totalDistanceMeters,
                totalDistanceText: eta.routeDistanceText,
                estimatedDurationSeconds: route.estimatedDurationSeconds,
                estimatedDurationText: eta.routeDurationText,
                etaToDestinationSeconds: eta.etaToDestinationSeconds,
                etaToDestinationText: eta.etaToDestinationText,
                distanceToDestinationMeters: eta.distanceToDestinationMeters,
                distanceToDestinationText: eta.distanceToDestinationText,
                averageSpeedKmph: eta.averageSpeedKmph,
                isActive: route.isActive,
            },
            stops: eta.stopsWithEta,
        };
    },

    startMyTracking: async (driverId: string, organizationId: string) => {
        const trip = await tripService.startTripForDriver(driverId, organizationId);

        return {
            tracking: {
                driverId,
                busId: trip.busId,
                isTracking: true,
                tripStatus: trip.status,
                startedAt: trip.startedAt,
            },
            trip,
        };
    },

    stopMyTracking: async (driverId: string, organizationId: string) => {
        const driver = await Driver.findOne({ _id: driverId, organizationId });
        if (!driver) {
            throw new Error('Driver not found');
        }

        if (!driver.assignedBusId) {
            throw new Error(buildNoBusAssignedMessage(driver));
        }

        const trip = await tripService.completeActiveTripForDriver(driverId, organizationId);
        if (!trip) {
            driver.isTracking = false;
            await driver.save();

            return {
                tracking: {
                    driverId,
                    busId: String(driver.assignedBusId),
                    isTracking: false,
                    tripStatus: null,
                    stoppedAt: new Date(),
                },
                trip: null,
            };
        }

        return {
            tracking: {
                driverId,
                busId: trip.busId,
                isTracking: false,
                tripStatus: trip.status,
                stoppedAt: trip.endedAt,
            },
            trip,
        };
    },

    updateAssignedBus: async (driverId: string, busId: string | null) => {
        const driver = await Driver.findByIdAndUpdate(
            driverId,
            { assignedBusId: busId || null },
            { new: true }
        ).populate('assignedBusId', 'numberPlate status currentLat currentLng lastUpdated routeId');

        if (!driver) {
            throw new Error('Driver not found');
        }

        const assignedBus = driver.assignedBusId as any;
        const activeTrip = assignedBus
            ? await tripService.getActiveTripByBusId(String(assignedBus._id), String(driver.organizationId))
            : null;

        return {
            id: String(driver._id),
            name: driver.name,
            memberId: driver.memberId,
            assignedBus: formatBusSnapshot(assignedBus, activeTrip),
        };
    },
};
