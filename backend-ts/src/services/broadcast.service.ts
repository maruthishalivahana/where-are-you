import { getIO } from '../websocket/socket.server';
import { logger } from '../utils/logger';

export interface BusLocationBroadcast {
    busId: string;
    tripId?: string;
    latitude: number;
    longitude: number;
    speed?: number;
    heading?: number;
    accuracy?: number;
    timestamp: string;
    eta?: string;
}

export interface StopUpdateBroadcast {
    busId: string;
    tripId: string;
    currentStopId: string;
    nextStopId?: string;
    timestamp: string;
    stopName?: string;
}

export interface EtaBroadcast {
    busId: string;
    tripId: string;
    estimatedArrival: string;
    distanceMeters: number;
    durationSeconds: number;
}

export interface NotificationBroadcast {
    type: 'bus_arriving' | 'bus_at_stop' | 'bus_delayed' | 'custom';
    title: string;
    message: string;
    busId: string;
    tripId: string;
    timestamp: string;
    data?: Record<string, unknown>;
}

const getTripRoom = (tripId: string): string => `trip:${tripId}`;
const getBusRoom = (busId: string): string => `bus:${busId}`;
const getRouteRoom = (routeId: string): string => `route:${routeId}`;

export const broadcastService = {
    /**
     * Broadcast location update to passengers on trip
     * CRITICAL: Only for PASSENGER apps, NOT driver sockets
     */
    broadcastBusLocation(tripId: string, locationData: BusLocationBroadcast): void {
        try {
            const io = getIO();
            const room = getTripRoom(tripId);

            io.to(room).emit('busLocationUpdate', {
                ...locationData,
                broadcastTimestamp: new Date().toISOString(),
            });

            logger.debug(`Broadcast location to trip room ${room}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to broadcast location: ${message}`);
        }
    },

    /**
     * Broadcast to specific route room (for route-level subscribers)
     */
    broadcastToRoute(routeId: string, event: string, data: Record<string, unknown>): void {
        try {
            const io = getIO();
            const room = getRouteRoom(routeId);

            io.to(room).emit(event, {
                ...data,
                broadcastTimestamp: new Date().toISOString(),
            });

            logger.debug(`Broadcast event ${event} to route room ${room}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to broadcast to route: ${message}`);
        }
    },

    /**
     * Broadcast stop update (bus reached stop)
     */
    broadcastStopUpdate(tripId: string, stopData: StopUpdateBroadcast): void {
        try {
            const io = getIO();
            const room = getTripRoom(tripId);

            io.to(room).emit('stopUpdate', {
                ...stopData,
                broadcastTimestamp: new Date().toISOString(),
            });

            logger.debug(`Broadcast stop update to trip room ${room}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to broadcast stop update: ${message}`);
        }
    },

    /**
     * Broadcast ETA update
     */
    broadcastEtaUpdate(tripId: string, etaData: EtaBroadcast): void {
        try {
            const io = getIO();
            const room = getTripRoom(tripId);

            io.to(room).emit('etaUpdate', {
                ...etaData,
                broadcastTimestamp: new Date().toISOString(),
            });

            logger.debug(`Broadcast ETA update to trip room ${room}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to broadcast ETA update: ${message}`);
        }
    },

    /**
     * Broadcast notification to trip subscribers
     */
    broadcastNotification(tripId: string, notification: NotificationBroadcast): void {
        try {
            const io = getIO();
            const room = getTripRoom(tripId);

            io.to(room).emit('notification', {
                ...notification,
                broadcastTimestamp: new Date().toISOString(),
            });

            logger.debug(`Broadcast notification to trip room ${room}: ${notification.title}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to broadcast notification: ${message}`);
        }
    },

    /**
     * Broadcast generic event to trip
     */
    broadcastToTrip(tripId: string, event: string, data: Record<string, unknown>): void {
        try {
            const io = getIO();
            const room = getTripRoom(tripId);

            io.to(room).emit(event, {
                ...data,
                broadcastTimestamp: new Date().toISOString(),
            });

            logger.debug(`Broadcast event ${event} to trip room ${room}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.warn(`Failed to broadcast to trip: ${message}`);
        }
    },

    /**
     * Get room name for trip
     */
    getTripRoom(tripId: string): string {
        return getTripRoom(tripId);
    },

    /**
     * Get room name for bus
     */
    getBusRoom(busId: string): string {
        return getBusRoom(busId);
    },

    /**
     * Get room name for route
     */
    getRouteRoom(routeId: string): string {
        return getRouteRoom(routeId);
    },
};
