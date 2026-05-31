import { Bus } from './bus.model';
import { Driver } from '../driver/driver.model';
import { Route } from '../route/route.model';
import { CreateBusInput } from './bus.validation';
import { BUS_LIFECYCLE_STATUS } from '../../constants/busLifecycle';
import { logger } from '../../utils/logger';
import { tripService } from '../trip/trip.service';
import { planService } from '../plan/plan.service';

const getRouteDetails = (routeRef: unknown): { routeId: string | null; routeName: string | null } => {
    if (!routeRef) {
        return { routeId: null, routeName: null };
    }

    const route = routeRef as any;
    const routeId = route._id || route;

    return {
        routeId: routeId ? String(routeId) : null,
        routeName: typeof route.name === 'string' ? route.name : null,
    };
};

const buildBusPayload = (bus: any, activeTrip?: any) => {
    const driver = bus.driverId as any;
    const route = getRouteDetails(bus.routeId);

    return {
        id: String(bus._id),
        numberPlate: bus.numberPlate,
        driver: driver
            ? {
                id: String(driver._id || driver),
                name: driver.name || '',
                memberId: driver.memberId || '',
            }
            : null,
        driverId: bus.driverId ? String((bus.driverId as any)._id || bus.driverId) : null,
        routeId: route.routeId,
        routeName: route.routeName,
        status: bus.status,
        currentLat: bus.currentLat,
        currentLng: bus.currentLng,
        currentSpeedMps: bus.currentSpeedMps,
        lastUpdated: bus.lastUpdated,
        tripStatus: activeTrip?.status || null,
        activeTrip: activeTrip || null,
    };
};

const resolveDriverForAssignment = async (
    organizationId: string,
    input: { memberId?: string; driverId?: string }
) => {
    const memberId = input.memberId?.trim();
    const driverId = input.driverId?.trim();

    if (memberId) {
        const driverByMemberId = await Driver.findOne({ organizationId, memberId });
        if (!driverByMemberId) {
            throw new Error(`Driver with memberId '${memberId}' not found`);
        }

        return driverByMemberId;
    }

    if (driverId) {
        const driverById = await Driver.findOne({ _id: driverId, organizationId });
        if (!driverById) {
            const crossOrgDriver = await Driver.findById(driverId).select('_id organizationId memberId');
            if (crossOrgDriver) {
                throw new Error(
                    `Driver '${driverId}' belongs to a different organization. Use a driver from this organization or login to the matching org.`
                );
            }

            throw new Error(`Driver with id '${driverId}' not found`);
        }

        return driverById;
    }

    throw new Error('memberId or driverId is required');
};

const resolveRouteForAssignment = async (
    organizationId: string,
    input: { routeName?: string; routeId?: string }
) => {
    const routeId = input.routeId?.trim();
    const routeName = input.routeName?.trim();

    if (routeId) {
        const routeById = await Route.findOne({ _id: routeId, organizationId });
        if (routeById) {
            return routeById;
        }

        const crossOrgRoute = await Route.findById(routeId).select('_id organizationId name');
        if (crossOrgRoute) {
            throw new Error(
                `Route '${routeId}' belongs to a different organization. Use a route from this organization or login to the matching org.`
            );
        }

        throw new Error(`Route with id '${routeId}' not found`);
    }

    if (routeName) {
        const routeByName = await Route.findOne({ organizationId, name: routeName });
        if (!routeByName) {
            throw new Error(`Route with name '${routeName}' not found`);
        }

        return routeByName;
    }

    return null;
};

export const busService = {
    createBus: async (organizationId: string, input: CreateBusInput) => {
        const existingBus = await Bus.findOne({
            organizationId,
            numberPlate: input.numberPlate,
        });

        if (existingBus) {
            throw new Error('Bus with this number plate already exists in your organization');
        }

        await planService.assertBusCapacity(organizationId);

        const route = await resolveRouteForAssignment(organizationId, {
            routeId: input.routeId,
            routeName: input.routeName,
        });

        const bus = await Bus.create({
            organizationId,
            numberPlate: input.numberPlate,
            driverId: (input.driverId || null) as any,
            routeId: route?._id as any,
            status: BUS_LIFECYCLE_STATUS.INACTIVE,
            lastUpdated: new Date(),
        });

        const payload = buildBusPayload(
            route
                ? {
                    ...bus.toObject(),
                    routeId: {
                        _id: route._id,
                        name: route.name,
                    },
                }
                : bus
        );

        return payload;
    },

    getBusesByOrganization: async (organizationId: string) => {
        const buses = await Bus.find({ organizationId })
            .populate('driverId', 'name memberId')
            .populate('routeId', 'name');

        const tripByBusId = await tripService.getActiveTripByBusIds(
            organizationId,
            buses.map((bus) => String(bus._id))
        );

        return buses.map((bus) => buildBusPayload(bus, tripByBusId.get(String(bus._id))));
    },

    getBusById: async (organizationId: string, busId: string) => {
        const bus = await Bus.findOne({
            _id: busId,
            organizationId,
        })
            .populate('driverId', 'name memberId')
            .populate('routeId', 'name');

        if (!bus) {
            throw new Error('Bus not found');
        }

        const activeTrip = await tripService.getActiveTripByBusId(busId, organizationId);
        return buildBusPayload(bus, activeTrip);
    },

    updateBusDriver: async (
        organizationId: string,
        busId: string,
        input: { memberId?: string; driverId?: string }
    ) => {
        const bus = await Bus.findOne({
            _id: busId,
            organizationId,
        });

        if (!bus) {
            throw new Error('Bus not found');
        }

        const driver = await resolveDriverForAssignment(organizationId, input);

        logger.info('[BusAssignment] Assignment requested', {
            organizationId,
            busId,
            requestedDriverId: String(driver._id),
            requestedDriverMemberId: driver.memberId,
        });

        const existingBusForDriver = await Bus.findOne({
            organizationId,
            driverId: driver._id,
            _id: { $ne: bus._id },
        });

        if (existingBusForDriver) {
            existingBusForDriver.driverId = null;
            await existingBusForDriver.save();
            logger.warn('[BusAssignment] Detached driver from previous bus', {
                organizationId,
                driverId: String(driver._id),
                previousBusId: String(existingBusForDriver._id),
            });
        }

        if (bus.driverId && String(bus.driverId) !== String(driver._id)) {
            await Driver.findByIdAndUpdate(bus.driverId, { assignedBusId: null });
        }

        bus.driverId = driver._id as any;
        await bus.save();

        await Driver.findByIdAndUpdate(driver._id, { assignedBusId: busId });

        logger.info('[BusAssignment] Assignment completed', {
            organizationId,
            busId,
            driverId: String(driver._id),
            driverMemberId: driver.memberId,
        });

        const payload = buildBusPayload(bus);
        return {
            ...payload,
            driverId: String(driver._id),
            driverMemberId: driver.memberId,
            driverName: driver.name,
        };
    },

    deleteBus: async (organizationId: string, busId: string) => {
        const bus = await Bus.findOneAndDelete({
            _id: busId,
            organizationId,
        });

        if (!bus) {
            throw new Error('Bus not found');
        }

        return { message: 'Bus deleted successfully' };
    },

    updateRouteForBus: async (
        organizationId: string,
        busId: string,
        routeInput: { routeName?: string; routeId?: string }
    ) => {
        const bus = await Bus.findOne({ _id: busId, organizationId });
        if (!bus) {
            throw new Error('Bus not found');
        }

        const route = await resolveRouteForAssignment(organizationId, routeInput);
        if (!route) {
            throw new Error('routeName or routeId is required');
        }

        logger.info('[BusAssignment] Route assignment requested', {
            organizationId,
            busId,
            routeId: String(route._id),
            routeName: route.name,
        });

        bus.routeId = route._id as any;
        bus.lastUpdated = new Date();
        await bus.save();

        const payload = buildBusPayload({
            ...bus.toObject(),
            routeId: {
                _id: route._id,
                name: route.name,
            },
        });

        logger.info('[BusAssignment] Route assignment completed', {
            organizationId,
            busId,
            routeId: String(route._id),
            routeName: route.name,
        });

        return payload;
    },
};
