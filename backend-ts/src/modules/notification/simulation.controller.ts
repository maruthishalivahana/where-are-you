import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Bus } from '../bus/bus.model';
import { Trip } from '../trip/trip.model';
import { Stop } from '../stop/stop.model';
import { User } from '../user/user.model';
import { notificationService } from './notification.service';
import { logger } from '../../utils/logger';

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

const getMessage = (error: unknown): string =>
	error instanceof Error ? error.message : 'Something went wrong';

type SimulationScenario =
	| 'trip_started'
	| 'trip_completed'
	| 'bus_near_stop'
	| 'bus_arrived'
	| 'delay_alert';

const VALID_SCENARIOS: SimulationScenario[] = [
	'trip_started',
	'trip_completed',
	'bus_near_stop',
	'bus_arrived',
	'delay_alert',
];

export const simulationController = {
	/**
	 * POST /api/debug/notifications/simulate
	 *
	 * Simulate bus notification scenarios for testing.
	 *
	 * Body:
	 * {
	 *   "scenario": "trip_started" | "trip_completed" | "bus_near_stop" | "bus_arrived" | "delay_alert",
	 *   "busId": "string (required)",
	 *   "stopId": "string (optional, for near/arrived - if omitted, uses first stop on route)",
	 *   "latitude": number (optional, override bus position),
	 *   "longitude": number (optional, override bus position),
	 *   "delayMinutes": number (optional, for delay_alert, default 10)
	 * }
	 */
	simulate: async (req: Request, res: Response): Promise<void> => {
		try {
			const organizationId = req.user?.organizationId;
			if (!organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const { scenario, busId, stopId, latitude, longitude, delayMinutes } = req.body;

			// Validate scenario
			if (!scenario || !VALID_SCENARIOS.includes(scenario)) {
				res.status(400).json({
					message: `Invalid scenario. Must be one of: ${VALID_SCENARIOS.join(', ')}`,
				});
				return;
			}

			// Validate busId
			if (!busId || typeof busId !== 'string') {
				res.status(400).json({ message: 'busId is required' });
				return;
			}

			// Look up bus
			const bus = await Bus.findOne({
				_id: toObjectId(busId),
				organizationId,
			}).select('_id numberPlate routeId organizationId');

			if (!bus) {
				res.status(404).json({ message: 'Bus not found in your organization' });
				return;
			}

			// Look up active trip for this bus
			const activeTrip = await Trip.findOne({
				busId: bus._id,
				organizationId,
				status: { $nin: ['COMPLETED', 'CANCELLED'] },
			}).sort({ createdAt: -1 });

			const tripId = activeTrip ? String(activeTrip._id) : 'simulated-trip';
			const routeId = bus.routeId ? String(bus.routeId) : '';

			const result: Record<string, unknown> = {
				scenario,
				busId: String(bus._id),
				busNumberPlate: bus.numberPlate,
				tripId,
				routeId,
				simulatedAt: new Date().toISOString(),
			};

			switch (scenario as SimulationScenario) {
				case 'trip_started': {
					await notificationService.handleTripStarted({
						organizationId: String(organizationId),
						busId: String(bus._id),
						busNumberPlate: bus.numberPlate,
						tripId,
						routeId,
					});
					result.message = 'Trip started notification triggered';
					break;
				}

				case 'trip_completed': {
					await notificationService.handleTripCompleted({
						organizationId: String(organizationId),
						busId: String(bus._id),
						busNumberPlate: bus.numberPlate,
						tripId,
						routeId,
					});
					result.message = 'Trip completed notification triggered';
					break;
				}

				case 'bus_near_stop': {
					// Determine stop position
					const stop = await getTargetStop(String(organizationId), routeId, stopId);
					if (!stop) {
						res.status(404).json({
							message: stopId
								? 'Stop not found'
								: 'No stops found on this bus route. Assign stops first.',
						});
						return;
					}

					// Place bus 100m from the stop
					const nearLat = latitude ?? stop.latitude + 0.0009;
					const nearLng = longitude ?? stop.longitude;

					await notificationService.processBusLocationUpdate({
						organizationId: String(organizationId),
						busId: String(bus._id),
						busNumberPlate: bus.numberPlate,
						latitude: nearLat,
						longitude: nearLng,
						isBusStartedEvent: false,
					});

					result.message = `Bus near stop notification triggered (simulated ~100m from ${stop.name})`;
					result.stopName = stop.name;
					result.stopId = String(stop._id);
					result.simulatedPosition = { latitude: nearLat, longitude: nearLng };
					break;
				}

				case 'bus_arrived': {
					const arrStop = await getTargetStop(String(organizationId), routeId, stopId);
					if (!arrStop) {
						res.status(404).json({
							message: stopId
								? 'Stop not found'
								: 'No stops found on this bus route. Assign stops first.',
						});
						return;
					}

					// Place bus at the stop (within 10m)
					const atLat = latitude ?? arrStop.latitude + 0.00005;
					const atLng = longitude ?? arrStop.longitude;

					await notificationService.processBusLocationUpdate({
						organizationId: String(organizationId),
						busId: String(bus._id),
						busNumberPlate: bus.numberPlate,
						latitude: atLat,
						longitude: atLng,
						isBusStartedEvent: false,
					});

					result.message = `Bus arrived notification triggered (simulated at ${arrStop.name})`;
					result.stopName = arrStop.name;
					result.stopId = String(arrStop._id);
					result.simulatedPosition = { latitude: atLat, longitude: atLng };
					break;
				}

				case 'delay_alert': {
					const delay = typeof delayMinutes === 'number' && delayMinutes > 0 ? delayMinutes : 10;

					await notificationService.handleDelayAlert({
						organizationId: String(organizationId),
						busId: String(bus._id),
						busNumberPlate: bus.numberPlate,
						tripId,
						routeId,
						delayMinutes: delay,
						reason: 'Simulated delay for testing',
					});

					result.message = `Delay alert notification triggered (${delay} minutes)`;
					result.delayMinutes = delay;
					break;
				}
			}

			logger.info(`[Simulation] ${scenario} simulated for bus ${bus.numberPlate}`);
			res.status(200).json(result);
		} catch (error) {
			logger.error('[Simulation] Error:', error);
			res.status(400).json({ message: getMessage(error) });
		}
	},

	/**
	 * POST /api/debug/notifications/test-push
	 *
	 * Send an end-to-end test push notification to a specific user (via userId or email) or direct deviceToken.
	 */
	testPush: async (req: Request, res: Response): Promise<void> => {
		try {
			const organizationId = req.user?.organizationId;
			if (!organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const { userId, email, deviceToken, title, body, data } = req.body;

			const pushTitle = title || 'Test Push Notification';
			const pushBody = body || 'This is a test notification from NavixGo backend.';
			const pushData = data || { type: 'test', sentAt: new Date().toISOString() };

			let tokens: string[] = [];

			if (deviceToken) {
				tokens = [deviceToken];
				logger.info(`[TestPush] Using direct device token: ${deviceToken.substring(0, 15)}...`);
			} else if (userId) {
				tokens = await notificationService.getUserDeviceTokens(userId);
				logger.info(`[TestPush] Found ${tokens.length} device tokens for userId=${userId}`);
			} else if (email) {
				const user = await User.findOne({ email, organizationId }).select('_id');
				if (!user) {
					res.status(404).json({ message: `User with email ${email} not found` });
					return;
				}
				tokens = await notificationService.getUserDeviceTokens(String(user._id));
				logger.info(`[TestPush] Found ${tokens.length} device tokens for email=${email} (userId=${user._id})`);
			} else {
				res.status(400).json({
					message: 'Please provide either deviceToken, userId, or email',
				});
				return;
			}

			if (tokens.length === 0) {
				res.status(404).json({
					message: 'No active device tokens found for the specified target. Make sure the device has registered token first.',
				});
				return;
			}

			const results: Array<{ token: string; success: boolean; error?: string; messageId?: string }> = [];
			const { sendPushNotification } = await import('../../utils/sendPushNotification');

			for (const token of tokens) {
				try {
					await sendPushNotification({
						fcmToken: token,
						title: pushTitle,
						body: pushBody,
						data: pushData,
					});
					results.push({
						token: token.substring(0, 15) + '...',
						success: true,
					});
				} catch (err: any) {
					results.push({
						token: token.substring(0, 15) + '...',
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			res.status(200).json({
				message: 'Test push execution completed',
				summary: {
					total: tokens.length,
					success: results.filter((r) => r.success).length,
					failure: results.filter((r) => !r.success).length,
				},
				results,
			});
		} catch (error) {
			logger.error('[TestPush] Error:', error);
			res.status(500).json({ message: getMessage(error) });
		}
	},
};

/**
 * Get target stop for simulation — uses stopId if provided, otherwise first stop on route
 */
async function getTargetStop(organizationId: string, routeId: string, stopId?: string) {
	if (stopId) {
		return Stop.findOne({
			_id: toObjectId(stopId),
			organizationId,
		}).select('_id name latitude longitude');
	}

	if (routeId) {
		return Stop.findOne({
			organizationId,
			routeId,
		})
			.sort({ sequenceOrder: 1 })
			.select('_id name latitude longitude');
	}

	return null;
}
