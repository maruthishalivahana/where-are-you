import mongoose from 'mongoose';
import { User } from './user.model';
import { hashPassword } from '../../utils/hashPassword';
import { Bus } from '../bus/bus.model';
import { Route } from '../route/route.model';
import { Stop } from '../stop/stop.model';
import { BusSubscription } from '../busSubscription/busSubscription.model';
import { buildEtaSnapshot } from '../../utils/eta';
import { calculateDistanceMeters } from '../../utils/calculateDistance';
import { tripService } from '../trip/trip.service';
import { Trip } from '../trip/trip.model';
import { ENV } from '../../config/env.config';

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

const formatUser = (user: any) => {
    const route = user.routeId as any;

    return {
        id: String(user._id),
        name: user.name,
        memberId: user.memberId,
        routeId: route ? String(route._id || route) : null,
        routeName: route?.name || null,
        email: user.email || null,
        phone: user.phone || null,
        organizationId: String(user.organizationId),
        createdAt: user.createdAt,
    };
};

const formatBusForClient = (bus: any, activeTrip: any) => {
    return {
        id: String(bus._id),
        numberPlate: bus.numberPlate,
        status: bus.status,
        tripStatus: activeTrip?.status || null,
        activeTrip: activeTrip || null,
        currentLat: bus.currentLat,
        currentLng: bus.currentLng,
        lastUpdated: bus.lastUpdated,
    };
};

export const userService = {
    getUsers: async (organizationId: string, search?: string) => {
        const query = search?.trim();
        const users = await User.find({
            organizationId: toObjectId(organizationId),
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
            .populate('routeId', 'name')
            .sort({ createdAt: -1 });

        return users.map(formatUser);
    },

    getUserById: async (organizationId: string, userId: string) => {
        const user = await User.findOne({
            _id: toObjectId(userId),
            organizationId: toObjectId(organizationId),
        }).populate('routeId', 'name');

        if (!user) throw new Error('User not found');
        return formatUser(user);
    },

    updateUser: async (
        organizationId: string,
        userId: string,
        input: { name?: string; memberId?: string; routeId?: string; email?: string; phone?: string; password?: string }
    ) => {
        const user = await User.findOne({ _id: toObjectId(userId), organizationId: toObjectId(organizationId) });
        if (!user) throw new Error('User not found');

        if (input.memberId && input.memberId !== user.memberId) {
            const duplicate = await User.findOne({
                organizationId: toObjectId(organizationId),
                memberId: input.memberId,
                _id: { $ne: toObjectId(userId) },
            });
            if (duplicate) throw new Error('memberId already in use');
        }

        if (input.routeId !== undefined && input.routeId) {
            const route = await Route.findOne({ _id: toObjectId(input.routeId), organizationId: toObjectId(organizationId) });
            if (!route) throw new Error('Route not found');
        }

        const normalizedEmail = input.email?.trim().toLowerCase();
        if (normalizedEmail && normalizedEmail !== user.email) {
            const duplicate = await User.findOne({
                organizationId: toObjectId(organizationId),
                email: normalizedEmail,
                _id: { $ne: toObjectId(userId) },
            });
            if (duplicate) throw new Error('email already in use');
        }

        const normalizedPhone = input.phone?.trim();
        if (normalizedPhone && normalizedPhone !== user.phone) {
            const duplicate = await User.findOne({
                organizationId: toObjectId(organizationId),
                phone: normalizedPhone,
                _id: { $ne: toObjectId(userId) },
            });
            if (duplicate) throw new Error('phone already in use');
        }

        const updates: Record<string, unknown> = {};
        if (input.name) updates.name = input.name.trim();
        if (input.memberId) updates.memberId = input.memberId.trim();
        if (input.routeId !== undefined) updates.routeId = input.routeId ? toObjectId(input.routeId) : null;
        if (input.email !== undefined) updates.email = normalizedEmail || null;
        if (input.phone !== undefined) updates.phone = normalizedPhone || null;
        if (input.password) updates.passwordHash = await hashPassword(input.password);

        const updated = await User.findByIdAndUpdate(userId, { $set: updates }, { new: true }).populate('routeId', 'name');
        return formatUser(updated!);
    },

    deleteUser: async (organizationId: string, userId: string) => {
        const user = await User.findOneAndDelete({ _id: toObjectId(userId), organizationId: toObjectId(organizationId) });
        if (!user) throw new Error('User not found');
        return { message: 'User deleted successfully' };
    },

    searchBusesForUser: async (organizationId: string, numberPlate: string) => {
        const query = numberPlate.trim();

        const buses = await Bus.find({
            organizationId: toObjectId(organizationId),
            numberPlate: { $regex: query, $options: 'i' },
        })
            .populate('routeId', 'name')
            .sort({ numberPlate: 1 })
            .limit(25);

        const tripByBusId = await tripService.getActiveTripByBusIds(
            organizationId,
            buses.map((bus) => String(bus._id))
        );

        return buses.map((bus) => {
            const route = bus.routeId as any;
            const busPayload = formatBusForClient(bus, tripByBusId.get(String(bus._id)));

            return {
                ...busPayload,
                routeId: route ? String(route._id) : null,
                routeName: route?.name || null,
                route: route
                    ? {
                        id: String(route._id),
                        name: route.name,
                    }
                    : null,
            };
        });
    },

    getLiveBusForUser: async (organizationId: string, busId: string) => {
        const bus = await Bus.findOne({
            _id: toObjectId(busId),
            organizationId: toObjectId(organizationId),
        }).populate('routeId');

        if (!bus) {
            throw new Error('Bus not found');
        }

        const activeTrip = await tripService.getActiveTripByBusId(String(bus._id), organizationId);

        const route = bus.routeId as any;
        const stops = route
            ? await Stop.find({
                organizationId: toObjectId(organizationId),
                routeId: route._id,
            }).sort({ sequenceOrder: 1 })
            : [];

        const hasLiveCoordinates =
            typeof bus.currentLat === 'number' &&
            typeof bus.currentLng === 'number' &&
            Number.isFinite(bus.currentLat) &&
            Number.isFinite(bus.currentLng) &&
            (bus.currentLat !== 0 || bus.currentLng !== 0);

        const normalizedStops = stops.map((stop) => ({
            id: String(stop._id),
            name: stop.name,
            latitude: stop.latitude,
            longitude: stop.longitude,
            sequenceOrder: stop.sequenceOrder,
            radiusMeters: stop.radiusMeters,
        }));

        const START_END_MERGE_RADIUS_METERS = 120;
        const hasStartStop =
            !!route &&
            normalizedStops.some(
                (stop) =>
                    calculateDistanceMeters(stop.latitude, stop.longitude, route.startLat, route.startLng) <=
                    START_END_MERGE_RADIUS_METERS
            );
        const hasEndStop =
            !!route &&
            normalizedStops.some(
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

        if (route && !hasStartStop) {
            stopsForEta.push({
                id: `start-${String(route._id)}`,
                name: route.startName || 'Start',
                latitude: route.startLat,
                longitude: route.startLng,
                sequenceOrder: firstSequence - 1,
                radiusMeters: 100,
            });
        }

        if (route && !hasEndStop) {
            stopsForEta.push({
                id: `end-${String(route._id)}`,
                name: route.endName || 'Destination',
                latitude: route.endLat,
                longitude: route.endLng,
                sequenceOrder: lastSequence + 1,
                radiusMeters: 100,
            });
        }

        const eta = route
            ? buildEtaSnapshot({
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
                    timezone: (route as any).timezone || ENV.TRACKING_TIMEZONE,
                },
                stops: stopsForEta,
            })
            : null;

        return {
            bus: {
                ...formatBusForClient(bus, activeTrip),
                routeId: route ? String(route._id) : null,
                routeName: route?.name || null,
            },
            route: route
                ? {
                    id: String(route._id),
                    name: route.name,
                    startName: route.startName || 'Start',
                    endName: route.endName || 'Destination',
                    startLat: route.startLat,
                    startLng: route.startLng,
                    endLat: route.endLat,
                    endLng: route.endLng,
                    encodedPolyline: route.encodedPolyline,
                    totalDistanceMeters: route.totalDistanceMeters,
                    totalDistanceText: eta?.routeDistanceText || null,
                    estimatedDurationSeconds: route.estimatedDurationSeconds,
                    estimatedDurationText: eta?.routeDurationText || null,
                    etaToDestinationSeconds: eta?.etaToDestinationSeconds || null,
                    etaToDestinationText: eta?.etaToDestinationText || null,
                    distanceToDestinationMeters: eta?.distanceToDestinationMeters || null,
                    distanceToDestinationText: eta?.distanceToDestinationText || null,
                    averageSpeedKmph: eta?.averageSpeedKmph || null,
                }
                : null,
            stops:
                eta?.stopsWithEta ||
                stopsForEta,
        };
    },

    subscribeToBus: async (
        organizationId: string,
        userId: string,
        input: {
            busId: string;
            stopId?: string;
            notifyOnBusStart?: boolean;
            notifyOnNearStop?: boolean;
            userLatitude?: number;
            userLongitude?: number;
            nearRadiusMeters?: number;
        }
    ) => {
        const bus = await Bus.findOne({
            _id: toObjectId(input.busId),
            organizationId: toObjectId(organizationId),
        });

        if (!bus) {
            throw new Error('Bus not found');
        }

        let stop: InstanceType<typeof Stop> | null = null;
        if (input.stopId) {
            stop = await Stop.findOne({
                _id: toObjectId(input.stopId),
                organizationId: toObjectId(organizationId),
            });

            if (!stop) {
                throw new Error('Stop not found');
            }
        }

        if ((input.userLatitude === undefined) !== (input.userLongitude === undefined)) {
            throw new Error('Both userLatitude and userLongitude are required together');
        }

        const subscription = await BusSubscription.findOneAndUpdate(
            {
                organizationId: toObjectId(organizationId),
                userId: toObjectId(userId),
                busId: toObjectId(input.busId),
            },
            {
                stopId: stop ? stop._id : null,
                notifyOnBusStart: input.notifyOnBusStart ?? true,
                notifyOnNearStop: input.notifyOnNearStop ?? true,
                userLatitude: input.userLatitude ?? null,
                userLongitude: input.userLongitude ?? null,
                nearRadiusMeters: input.nearRadiusMeters ?? 150,
                isActive: true,
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).populate('stopId', 'name latitude longitude sequenceOrder radiusMeters');

        const populatedStop = subscription?.stopId as any;

        return {
            id: String(subscription!._id),
            busId: String(subscription!.busId),
            stop: populatedStop
                ? {
                    id: String(populatedStop._id),
                    name: populatedStop.name,
                    latitude: populatedStop.latitude,
                    longitude: populatedStop.longitude,
                    sequenceOrder: populatedStop.sequenceOrder,
                    radiusMeters: populatedStop.radiusMeters,
                }
                : null,
            notifyOnBusStart: subscription!.notifyOnBusStart,
            notifyOnNearStop: subscription!.notifyOnNearStop,
            userLatitude: subscription!.userLatitude,
            userLongitude: subscription!.userLongitude,
            nearRadiusMeters: subscription!.nearRadiusMeters,
            isActive: subscription!.isActive,
            createdAt: subscription!.createdAt,
            updatedAt: subscription!.updatedAt,
        };
    },

    getMySubscriptions: async (organizationId: string, userId: string) => {
        const subscriptions = await BusSubscription.find({
            organizationId: toObjectId(organizationId),
            userId: toObjectId(userId),
            isActive: true,
        })
            .populate(
                'busId',
                'numberPlate status currentLat currentLng lastUpdated routeId'
            )
            .populate('stopId', 'name latitude longitude sequenceOrder radiusMeters')
            .sort({ createdAt: -1 });

        const busIds = subscriptions
            .map((subscription) => subscription.busId as any)
            .filter(Boolean)
            .map((bus) => String(bus._id || bus));

        const tripByBusId = await tripService.getActiveTripByBusIds(organizationId, busIds);

        return subscriptions.map((subscription) => {
            const bus = subscription.busId as any;
            const stop = subscription.stopId as any;

            return {
                id: String(subscription._id),
                bus: bus
                    ? formatBusForClient(bus, tripByBusId.get(String(bus._id)))
                    : null,
                stop: stop
                    ? {
                        id: String(stop._id),
                        name: stop.name,
                        latitude: stop.latitude,
                        longitude: stop.longitude,
                        sequenceOrder: stop.sequenceOrder,
                        radiusMeters: stop.radiusMeters,
                    }
                    : null,
                notifyOnBusStart: subscription.notifyOnBusStart,
                notifyOnNearStop: subscription.notifyOnNearStop,
                userLatitude: subscription.userLatitude,
                userLongitude: subscription.userLongitude,
                nearRadiusMeters: subscription.nearRadiusMeters,
                isActive: subscription.isActive,
                createdAt: subscription.createdAt,
                updatedAt: subscription.updatedAt,
            };
        });
    },

    unsubscribeFromBus: async (organizationId: string, userId: string, subscriptionId: string) => {
        const subscription = await BusSubscription.findOneAndUpdate(
            {
                _id: toObjectId(subscriptionId),
                organizationId: toObjectId(organizationId),
                userId: toObjectId(userId),
            },
            { isActive: false },
            { new: true }
        );

        if (!subscription) {
            throw new Error('Subscription not found');
        }

        return { message: 'Subscription removed successfully' };
    },

    updateMyFcmToken: async (organizationId: string, userId: string, fcmToken: string) => {
        const user = await User.findOneAndUpdate(
            {
                _id: toObjectId(userId),
                organizationId: toObjectId(organizationId),
            },
            { fcmToken: fcmToken.trim() },
            { new: true }
        );

        if (!user) {
            throw new Error('User not found');
        }

        return {
            id: String(user._id),
            memberId: user.memberId,
            fcmToken: user.fcmToken,
        };
    },

    /**
     * PHASE 3: Get passenger automatic tracking data
     * Flow:
     * 1. Get authenticated user
     * 2. Verify user has assigned route
     * 3. Get active trip for that route
     * 4. Return route + trip + bus + driver info
     * 
     * Used by: GET /api/user/tracking/active-trip
     */
    getPassengerTrackingData: async (userId: string, organizationId: string) => {
        // Step 1: Get user with assigned route
        const user = await User.findOne({
            _id: toObjectId(userId),
            organizationId: toObjectId(organizationId),
        }).populate('routeId', 'name startName endName startLat startLng endLat endLng encodedPolyline totalDistanceMeters estimatedDurationSeconds');

        if (!user) {
            throw new Error('User not found');
        }

        // Step 2: Validate user has assigned route
        const route = user.routeId as any;
        if (!route) {
            return {
                success: true,
                route: null,
                trip: null,
                bus: null,
                driver: null,
                stops: null,
                message: 'No route assigned to this user',
            };
        }

        // Step 3: Get all stops for this route (sorted by sequence)
        const stops = await Stop.find({
            routeId: route._id,
            organizationId: toObjectId(organizationId),
        }).sort({ sequenceOrder: 1 });

        // Step 4: Get active trip for this route's bus
        // Since one bus per route, find the active trip on this route
        const trip = await Trip.findOne({
            routeId: route._id,
            organizationId: toObjectId(organizationId),
            status: { $nin: ['COMPLETED', 'CANCELLED'] },
        })
            .sort({ createdAt: -1 })
            .populate('busId', 'numberPlate status')
            .populate('driverId', 'name memberId phone')
            .populate('routeId', 'name startName endName');

        // Step 5: Format and return response
        return {
            success: true,
            route: route ? {
                id: String(route._id),
                name: route.name,
                startName: route.startName || 'Start',
                endName: route.endName || 'Destination',
                startLat: route.startLat,
                startLng: route.startLng,
                endLat: route.endLat,
                endLng: route.endLng,
                encodedPolyline: route.encodedPolyline,
                totalDistanceMeters: route.totalDistanceMeters,
                estimatedDurationSeconds: route.estimatedDurationSeconds,
            } : null,
            stops: stops.length > 0 ? stops.map(stop => ({
                id: String(stop._id),
                name: stop.name,
                latitude: stop.latitude,
                longitude: stop.longitude,
                sequenceOrder: stop.sequenceOrder,
                radiusMeters: stop.radiusMeters,
            })) : null,
            trip: trip ? {
                id: String(trip._id),
                status: trip.status,
                startedAt: trip.startedAt || null,
                currentLocation: trip.currentLocation || null,
                createdAt: trip.createdAt,
            } : null,
            bus: trip?.busId ? {
                id: String((trip.busId as any)._id || trip.busId),
                numberPlate: (trip.busId as any).numberPlate,
                status: (trip.busId as any).status,
            } : null,
            driver: trip?.driverId ? {
                id: String((trip.driverId as any)._id || trip.driverId),
                name: (trip.driverId as any).name,
                memberId: (trip.driverId as any).memberId,
                phone: (trip.driverId as any).phone,
            } : null,
            message: trip ? 'Active trip found' : 'No active trip at the moment',
        };
    },

    /**
     * Get available routes for user to select (showing with stop count)
     */
    getAvailableRoutes: async (organizationId: string) => {
        const routes = await Route.find({
            organizationId: toObjectId(organizationId),
        })
            .select('_id name description')
            .populate('stops', '_id name')
            .sort({ name: 1 });

        // Get stop counts for each route
        const routeIds = routes.map(r => r._id);
        const stopCounts = await Stop.aggregate([
            { $match: { routeId: { $in: routeIds } } },
            { $group: { _id: '$routeId', count: { $sum: 1 } } },
        ]);

        const stopCountMap = new Map(stopCounts.map((sc: any) => [sc._id.toString(), sc.count]));
        return routes.map((route: any) => ({
            id: String(route._id),
            name: route.name,
            description: route.description,
            stopCount: stopCountMap.get(route._id.toString()) || 0,
        }));
    },

    /**
     * Get stops for a specific route
     */
    getRouteStops: async (organizationId: string, routeId: string) => {
        // Validate route exists
        const route = await Route.findOne({
            _id: toObjectId(routeId),
            organizationId: toObjectId(organizationId),
        });

        if (!route) throw new Error('Route not found');

        // Get stops for this route
        const stops = await Stop.find({
            routeId: toObjectId(routeId),
            organizationId: toObjectId(organizationId),
        }).sort({ sequenceOrder: 1 });

        return stops.map((stop: any) => ({
            id: String(stop._id),
            name: stop.name,
            latitude: stop.latitude,
            longitude: stop.longitude,
            sequenceOrder: stop.sequenceOrder,
        }));
    },

    /**
     * Assign stop to user (select their pickup stop)
     */
    assignStop: async (userId: string, organizationId: string, routeId: string, stopId: string) => {
        const user = await User.findOne({
            _id: toObjectId(userId),
            organizationId: toObjectId(organizationId),
        });

        if (!user) throw new Error('User not found');

        // Validate route exists and belongs to org
        const route = await Route.findOne({
            _id: toObjectId(routeId),
            organizationId: toObjectId(organizationId),
        });

        if (!route) throw new Error('Route not found');

        // Validate stop exists and belongs to route
        const stop = await Stop.findOne({
            _id: toObjectId(stopId),
            routeId: toObjectId(routeId),
            organizationId: toObjectId(organizationId),
        });

        if (!stop) throw new Error('Stop not found');

        // Update user with route and stop
        user.routeId = toObjectId(routeId);
        user.stopId = toObjectId(stopId);
        await user.save();

        return user;
    },

    /**
     * Get user's assigned stop with route details
     */
    getAssignedStop: async (userId: string, organizationId: string) => {
        const user = await User.findOne({
            _id: toObjectId(userId),
            organizationId: toObjectId(organizationId),
        })
            .populate('routeId', 'name description')
            .populate('stopId', 'name latitude longitude sequenceOrder');

        if (!user) throw new Error('User not found');

        const route = user.routeId as any;
        const stop = user.stopId as any;

        return {
            routeId: route ? String(route._id) : null,
            routeName: route?.name || null,
            stopId: stop ? String(stop._id) : null,
            stopName: stop?.name || null,
            stopLatitude: stop?.latitude || null,
            stopLongitude: stop?.longitude || null,
            stopSequence: stop?.sequenceOrder || null,
        };
    },
};
