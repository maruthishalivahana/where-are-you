import mongoose from 'mongoose';
import { User } from './user.model';
import { hashPassword } from '../../utils/hashPassword';
import { Bus } from '../bus/bus.model';
import { Route } from '../route/route.model';
import { Stop } from '../stop/stop.model';
import { BusSubscription } from '../busSubscription/busSubscription.model';
import { buildEtaSnapshot } from '../../utils/eta';

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

const formatUser = (user: InstanceType<typeof User>) => ({
    id: String(user._id),
    name: user.name,
    memberId: user.memberId,
    organizationId: String(user.organizationId),
    createdAt: user.createdAt,
});

export const userService = {
    getUsers: async (organizationId: string) => {
        const users = await User.find({ organizationId: toObjectId(organizationId) }).sort({ createdAt: -1 });
        return users.map(formatUser);
    },

    getUserById: async (organizationId: string, userId: string) => {
        const user = await User.findOne({ _id: toObjectId(userId), organizationId: toObjectId(organizationId) });
        if (!user) throw new Error('User not found');
        return formatUser(user);
    },

    updateUser: async (
        organizationId: string,
        userId: string,
        input: { name?: string; memberId?: string; password?: string }
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

        const updates: Record<string, unknown> = {};
        if (input.name) updates.name = input.name.trim();
        if (input.memberId) updates.memberId = input.memberId.trim();
        if (input.password) updates.passwordHash = await hashPassword(input.password);

        const updated = await User.findByIdAndUpdate(userId, { $set: updates }, { new: true });
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

        return buses.map((bus) => {
            const route = bus.routeId as any;

            return {
                id: String(bus._id),
                numberPlate: bus.numberPlate,
                status: bus.status,
                trackingStatus: bus.trackingStatus,
                currentLat: bus.currentLat,
                currentLng: bus.currentLng,
                lastUpdated: bus.lastUpdated,
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

        return {
            bus: {
                id: String(bus._id),
                numberPlate: bus.numberPlate,
                status: bus.status,
                trackingStatus: bus.trackingStatus,
                currentLat: bus.currentLat,
                currentLng: bus.currentLng,
                lastUpdated: bus.lastUpdated,
            },
            route: route
                ? {
                      id: String(route._id),
                      name: route.name,
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
                stops.map((stop) => ({
                    id: String(stop._id),
                    name: stop.name,
                    latitude: stop.latitude,
                    longitude: stop.longitude,
                    sequenceOrder: stop.sequenceOrder,
                    radiusMeters: stop.radiusMeters,
                })),
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
            .populate('busId', 'numberPlate status trackingStatus currentLat currentLng lastUpdated')
            .populate('stopId', 'name latitude longitude sequenceOrder radiusMeters')
            .sort({ createdAt: -1 });

        return subscriptions.map((subscription) => {
            const bus = subscription.busId as any;
            const stop = subscription.stopId as any;

            return {
                id: String(subscription._id),
                bus: bus
                    ? {
                          id: String(bus._id),
                          numberPlate: bus.numberPlate,
                          status: bus.status,
                          trackingStatus: bus.trackingStatus,
                          currentLat: bus.currentLat,
                          currentLng: bus.currentLng,
                          lastUpdated: bus.lastUpdated,
                      }
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
};
