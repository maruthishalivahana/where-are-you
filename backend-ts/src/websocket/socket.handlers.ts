import { Socket } from 'socket.io';
import mongoose from 'mongoose';
import { TRACKING_EVENTS } from '../modules/tracking/tracking.events';
import { logger } from '../utils/logger';
import { getBusRoom, getRouteRoom } from './socket.rooms';
import { ROLES } from '../constants/roles';
import { Bus } from '../modules/bus/bus.model';
import { Route } from '../modules/route/route.model';

/**
 * REFACTORED Socket Handlers
 * 
 * REMOVED:
 * - Driver location update handler (driverLocationUpdate)
 * - Driver socket authentication
 * - Socket-based tracking ingestion
 * 
 * KEPT:
 * - Passenger room subscriptions (JOIN_BUS_ROOM, JOIN_ROUTE_ROOM)
 * - Route/Bus broadcast listeners
 * 
 * RATIONALE:
 * - Drivers now use HTTP batch uploads (battery-efficient)
 * - WebSockets are for PASSENGER apps only
 * - No persistent driver socket connections
 * - Location broadcast to passengers from Redis cache
 */

const escapeRegex = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const registerSocketHandlers = (socket: Socket): void => {
	/**
	 * Passenger/Admin joins bus room to receive location updates
	 * PASSENGERS ONLY - drivers use HTTP batch API
	 */
	socket.on(TRACKING_EVENTS.JOIN_BUS_ROOM, async (busId: string) => {
		try {
			if (!socket.data.user) {
				logger.warn(`joinBusRoom: No user data for socket ${socket.id}`);
				return;
			}

			// CRITICAL: Only passengers and admins can join bus rooms
			if (![ROLES.USER, ROLES.ADMIN].includes(socket.data.user.role)) {
				logger.warn(
					`joinBusRoom denied: socket=${socket.id}, role=${socket.data.user.role} (drivers use HTTP batch API)`
				);
				return;
			}

			if (!busId || typeof busId !== 'string') {
				return;
			}

			const trimmedBusId = busId.trim();
			const busSelectors: Array<Record<string, unknown>> = [
				{ numberPlate: new RegExp(`^${escapeRegex(trimmedBusId)}$`, 'i') },
			];

			if (mongoose.isValidObjectId(trimmedBusId)) {
				busSelectors.unshift({ _id: trimmedBusId });
			}

			const bus = await Bus.findOne({
				organizationId: socket.data.user.organizationId,
				$or: busSelectors,
			}).select('_id numberPlate');

			if (!bus) {
				logger.warn(
					`joinBusRoom denied: bus not found, socket=${socket.id}, role=${socket.data.user.role}, busRef=${trimmedBusId}`
				);
				return;
			}

			socket.join(getBusRoom(String(bus._id)));
			logger.info(`Socket ${socket.id} joined bus room: ${getBusRoom(String(bus._id))}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown socket error';
			logger.warn(`joinBusRoom failed for socket ${socket.id}: ${message}`);
		}
	});

	/**
	 * Passenger/Admin joins route room to receive ETA and stop updates
	 * PASSENGERS ONLY - drivers do not subscribe to route rooms
	 */
	socket.on(TRACKING_EVENTS.JOIN_ROUTE_ROOM, async (routeId: string) => {
		try {
			if (!socket.data.user) {
				logger.warn(`joinRouteRoom: No user data for socket ${socket.id}`);
				return;
			}

			// CRITICAL: Only passengers and admins can join route rooms
			if (![ROLES.USER, ROLES.ADMIN].includes(socket.data.user.role)) {
				logger.warn(
					`joinRouteRoom denied: socket=${socket.id}, role=${socket.data.user.role}`
				);
				return;
			}

			if (!routeId || typeof routeId !== 'string') {
				return;
			}

			const trimmedRouteId = routeId.trim();
			if (!mongoose.isValidObjectId(trimmedRouteId)) {
				return;
			}

			const route = await Route.findOne({
				_id: trimmedRouteId,
				organizationId: socket.data.user.organizationId,
			}).select('_id');

			if (!route) {
				logger.warn(
					`joinRouteRoom denied: route not found, socket=${socket.id}, role=${socket.data.user.role}, routeId=${trimmedRouteId}`
				);
				return;
			}

			socket.join(getRouteRoom(String(route._id)));
			logger.info(`Socket ${socket.id} joined route room: ${getRouteRoom(String(route._id))}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown socket error';
			logger.warn(`joinRouteRoom failed for socket ${socket.id}: ${message}`);
		}
	});

	/**
	 * REMOVED: DRIVER_LOCATION_UPDATE handler
	 * 
	 * This handler was used for realtime driver location updates via WebSocket.
	 * It has been COMPLETELY REMOVED because:
	 * 
	 * 1. UNRELIABLE: iOS suspends WebSocket connections in background
	 * 2. BATTERY INEFFICIENT: Persistent socket connections drain battery
	 * 3. SCALABILITY: 1000+ drivers require massive server memory
	 * 4. BETTER APPROACH: HTTP batch uploads are more reliable
	 * 
	 * Drivers now use: POST /api/tracking/batch (HTTP API)
	 * Benefits:
	 * - Works in background mode
	 * - Battery efficient (periodic requests vs persistent connection)
	 * - Easier to scale (stateless HTTP)
	 * - Built-in retry logic
	 * - Replay attack prevention (nonce)
	 * - Rate limiting
	 */

	socket.on('disconnect', () => {
		logger.info(`Socket client disconnected: ${socket.id}`);
	});
};
