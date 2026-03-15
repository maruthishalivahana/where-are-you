import { Stop } from './stop.model';
import { Route } from '../route/route.model';
import { routeService } from '../route/route.service';

interface CreateStopInput {
    name: string;
    latitude: number;
    longitude: number;
    sequenceOrder: number;
    radiusMeters?: number;
}

interface UpdateStopInput {
    name?: string;
    latitude?: number;
    longitude?: number;
    sequenceOrder?: number;
    radiusMeters?: number;
}

const validateCoords = (lat: number, lng: number) => {
    if (lat < -90 || lat > 90) throw new Error('latitude must be between -90 and 90');
    if (lng < -180 || lng > 180) throw new Error('longitude must be between -180 and 180');
};

const verifyRouteOwnership = async (organizationId: string, routeId: string) => {
    const route = await Route.findOne({ _id: routeId, organizationId });
    if (!route) throw new Error('Route not found or does not belong to your organization');
    return route;
};

const formatStop = (stop: InstanceType<typeof Stop>) => ({
    id: String(stop._id),
    routeId: String(stop.routeId),
    name: stop.name,
    latitude: stop.latitude,
    longitude: stop.longitude,
    sequenceOrder: stop.sequenceOrder,
    radiusMeters: stop.radiusMeters,
    createdAt: stop.createdAt,
    updatedAt: stop.updatedAt,
});

export const stopService = {
    createStop: async (organizationId: string, routeId: string, input: CreateStopInput) => {
        await verifyRouteOwnership(organizationId, routeId);

        validateCoords(input.latitude, input.longitude);

        const duplicate = await Stop.findOne({ organizationId, routeId, sequenceOrder: input.sequenceOrder });
        if (duplicate) {
            throw new Error(`sequenceOrder ${input.sequenceOrder} already exists on this route`);
        }

        const stop = await Stop.create({
            organizationId,
            routeId,
            name: input.name.trim(),
            latitude: input.latitude,
            longitude: input.longitude,
            sequenceOrder: input.sequenceOrder,
            radiusMeters: input.radiusMeters ?? 100,
        });

        await routeService.markRoutePolylineDirty(organizationId, routeId, 'stop_created');

        return formatStop(stop);
    },

    getStopsByRoute: async (organizationId: string, routeId: string) => {
        await verifyRouteOwnership(organizationId, routeId);

        const stops = await Stop.find({ organizationId, routeId }).sort({ sequenceOrder: 1 });
        return stops.map(formatStop);
    },

    updateStop: async (organizationId: string, stopId: string, input: UpdateStopInput) => {
        const stop = await Stop.findOne({ _id: stopId, organizationId });
        if (!stop) throw new Error('Stop not found');

        const shouldRecalculateRoute =
            input.latitude !== undefined ||
            input.longitude !== undefined ||
            input.sequenceOrder !== undefined;

        if (input.latitude !== undefined || input.longitude !== undefined) {
            validateCoords(
                input.latitude ?? stop.latitude,
                input.longitude ?? stop.longitude
            );
        }

        if (input.sequenceOrder !== undefined && input.sequenceOrder !== stop.sequenceOrder) {
            const duplicate = await Stop.findOne({
                organizationId,
                routeId: stop.routeId,
                sequenceOrder: input.sequenceOrder,
                _id: { $ne: stopId },
            });
            if (duplicate) {
                throw new Error(`sequenceOrder ${input.sequenceOrder} already exists on this route`);
            }
        }

        const updated = await Stop.findByIdAndUpdate(stopId, { $set: input }, { new: true });

        if (shouldRecalculateRoute) {
            await routeService.markRoutePolylineDirty(
                organizationId,
                String(stop.routeId),
                'stop_updated_or_reordered'
            );
        }

        return formatStop(updated!);
    },

    deleteStop: async (organizationId: string, stopId: string) => {
        const stop = await Stop.findOneAndDelete({ _id: stopId, organizationId });
        if (!stop) throw new Error('Stop not found');

        await routeService.markRoutePolylineDirty(
            organizationId,
            String(stop.routeId),
            'stop_deleted'
        );

        return { message: 'Stop deleted successfully' };
    },
};
