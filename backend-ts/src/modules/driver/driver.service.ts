import { Driver } from './driver.model';
import { Bus } from '../bus/bus.model';
import { Route } from '../route/route.model';
import { Stop } from '../stop/stop.model';
import { buildEtaSnapshot } from '../../utils/eta';

export const driverService = {
    listDriversByOrganization: async (organizationId: string) => {
        const drivers = await Driver.find({ organizationId })
            .select('_id name memberId')
            .sort({ name: 1 });

        return drivers.map((driver) => ({
            id: String(driver._id),
            name: driver.name,
            memberId: driver.memberId,
        }));
    },
    getMyDetails: async (driverId: string) => {
        const driver = await Driver.findById(driverId).populate('assignedBusId', 'numberPlate status currentLat currentLng');

        if (!driver) {
            throw new Error('Driver not found');
        }

        const assignedBus = driver.assignedBusId as any;

        return {
            id: String(driver._id),
            name: driver.name,
            memberId: driver.memberId,
            organizationId: String(driver.organizationId),
            assignedBus: assignedBus
                ? {
                    id: String(assignedBus._id),
                    numberPlate: assignedBus.numberPlate,
                    status: assignedBus.status,
                    currentLat: assignedBus.currentLat,
                    currentLng: assignedBus.currentLng,
                }
                : null,
        };
    },

    getMyBus: async (driverId: string) => {
        const driver = await Driver.findById(driverId).populate('assignedBusId');

        if (!driver || !driver.assignedBusId) {
            throw new Error('No bus assigned to this driver');
        }

        const bus = driver.assignedBusId as any;

        return {
            id: String(bus._id),
            numberPlate: bus.numberPlate,
            status: bus.status,
            currentLat: bus.currentLat,
            currentLng: bus.currentLng,
            lastUpdated: bus.lastUpdated,
        };
    },

    getMyRoute: async (driverId: string) => {
        const driver = await Driver.findById(driverId).populate('assignedBusId');

        if (!driver || !driver.assignedBusId) {
            throw new Error('No bus assigned to this driver');
        }

        const bus = driver.assignedBusId as any;

        if (!bus.routeId) {
            throw new Error('No route assigned to this bus');
        }

        const route = await Route.findOne({
            _id: bus.routeId,
            organizationId: driver.organizationId,
        });

        if (!route) {
            throw new Error('Route not found');
        }

        const stops = await Stop.find({
            organizationId: driver.organizationId,
            routeId: route._id,
        }).sort({ sequenceOrder: 1 });

        const hasLiveCoordinates =
            typeof bus.currentLat === 'number' &&
            typeof bus.currentLng === 'number' &&
            Number.isFinite(bus.currentLat) &&
            Number.isFinite(bus.currentLng) &&
            (bus.currentLat !== 0 || bus.currentLng !== 0);

        const eta = buildEtaSnapshot({
            current: {
                latitude: hasLiveCoordinates ? bus.currentLat : route.startLat,
                longitude: hasLiveCoordinates ? bus.currentLng : route.startLng,
            },
            route: {
                totalDistanceMeters: route.totalDistanceMeters,
                estimatedDurationSeconds: route.estimatedDurationSeconds,
                endLat: route.endLat,
                endLng: route.endLng,
                polyline: route.polyline || route.encodedPolyline,
            },
            stops: stops.map((stop) => ({
                id: String(stop._id),
                name: stop.name,
                latitude: stop.latitude,
                longitude: stop.longitude,
                sequenceOrder: stop.sequenceOrder,
                radiusMeters: stop.radiusMeters,
            })),
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

        driver.isTracking = true;
        await driver.save();

        bus.trackingStatus = 'running';
        bus.lastUpdated = new Date();
        await bus.save();

        return {
            tracking: {
                driverId: String(driver._id),
                busId: String(bus._id),
                isTracking: driver.isTracking,
                trackingStatus: bus.trackingStatus,
                startedAt: bus.lastUpdated,
            },
        };
    },

    stopMyTracking: async (driverId: string, organizationId: string) => {
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

        driver.isTracking = false;
        await driver.save();

        bus.trackingStatus = 'stopped';
        bus.lastUpdated = new Date();
        await bus.save();

        return {
            tracking: {
                driverId: String(driver._id),
                busId: String(bus._id),
                isTracking: driver.isTracking,
                trackingStatus: bus.trackingStatus,
                stoppedAt: bus.lastUpdated,
            },
        };
    },

    updateAssignedBus: async (driverId: string, busId: string | null) => {
        const driver = await Driver.findByIdAndUpdate(
            driverId,
            { assignedBusId: busId || null },
            { new: true }
        ).populate('assignedBusId', 'numberPlate status');

        if (!driver) {
            throw new Error('Driver not found');
        }

        const assignedBus = driver.assignedBusId as any;

        return {
            id: String(driver._id),
            name: driver.name,
            memberId: driver.memberId,
            assignedBus: assignedBus
                ? {
                    id: String(assignedBus._id),
                    numberPlate: assignedBus.numberPlate,
                    status: assignedBus.status,
                }
                : null,
        };
    },
};



