import mongoose from 'mongoose';
import { NOTIFICATION_TYPES } from '../../constants/notificationTypes';
import { calculateDistanceMeters } from '../../utils/calculateDistance';
import { BusSubscription } from '../busSubscription/busSubscription.model';
import { Stop } from '../stop/stop.model';
import { Notification } from './notification.model';
import { User } from '../user/user.model';
import { Bus } from '../bus/bus.model';
import { Trip } from '../trip/trip.model';
import { ACTIVE_TRIP_TERMINAL_STATUSES } from '../../constants/tripStatus';
import { redisService } from '../../services/redis.service';
import { sendPushNotification } from '../../utils/sendPushNotification';
import { DeviceToken } from './deviceToken.model';
import { logger } from '../../utils/logger';
import { Route } from '../route/route.model';

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);
const NEAR_STOP_COOLDOWN_MS = 5 * 60 * 1000;
const ARRIVED_THRESHOLD_M = 100;
const ARRIVED_COOLDOWN_MS = 10 * 60 * 1000;

const formatNotification = (notification: InstanceType<typeof Notification>) => ({
	id: String(notification._id),
	type: notification.type,
	title: notification.title,
	message: notification.message,
	isRead: notification.isRead,
	busId: notification.busId ? String(notification.busId) : null,
	stopId: notification.stopId ? String(notification.stopId) : null,
	payload: notification.payload || {},
	createdAt: notification.createdAt,
	updatedAt: notification.updatedAt,
});

export const notificationService = {
	getMyNotifications: async (organizationId: string, userId: string) => {
		const notifications = await Notification.find({
			organizationId: toObjectId(organizationId),
			userId: toObjectId(userId),
		})
			.sort({ createdAt: -1 })
			.limit(100);

		return notifications.map(formatNotification);
	},

	markAsRead: async (organizationId: string, userId: string, notificationId: string) => {
		const notification = await Notification.findOneAndUpdate(
			{
				_id: toObjectId(notificationId),
				organizationId: toObjectId(organizationId),
				userId: toObjectId(userId),
			},
			{ isRead: true },
			{ new: true }
		);

		if (!notification) {
			throw new Error('Notification not found');
		}

		return formatNotification(notification);
	},

	processBusLocationUpdate: async (input: {
		organizationId: string;
		busId: string;
		busNumberPlate: string;
		latitude: number;
		longitude: number;
		isBusStartedEvent: boolean;
		timestamp?: Date | string;
	}) => {
		logger.info(`[GPS POSITION] busId=${input.busId}, plate=${input.busNumberPlate}, lat=${input.latitude}, lng=${input.longitude}`);

		// 1. Stale Location Verification
		if (input.timestamp) {
			const pingTime = new Date(input.timestamp).getTime();
			const now = Date.now();
			const ageMs = now - pingTime;
			if (ageMs > 2 * 60 * 1000) { // older than 2 minutes
				logger.warn(`[Notification] Skipping stale location update for busId=${input.busId} — age is ${Math.round(ageMs / 1000)}s`);
				return;
			}
		}

		// 2. Fetch Active Trip & Route information
		const activeTrip = await Trip.findOne({
			busId: toObjectId(input.busId),
			organizationId: toObjectId(input.organizationId),
			status: { $nin: ['COMPLETED', 'CANCELLED'] },
		}).select('_id routeId status');

		if (!activeTrip) {
			logger.warn(`[Notification] No active trip found for busId=${input.busId} — skipping notification processing`);
			return;
		}

		const routeId = activeTrip.routeId;
		const route = await Route.findById(routeId).select('name').lean();
		const routeName = route?.name || 'Unknown Route';

		// 3. Resolve implicit route-based subscriptions first
		try {
			logger.info(`[Notification] Active trip found: ${activeTrip._id} on route: ${routeId}. Resolving implicit subscriptions...`);

			const routeUsers = await User.find({
				organizationId: toObjectId(input.organizationId),
				routeId: routeId,
				stopId: { $exists: true, $ne: null },
			}).select('_id name stopId');

			logger.info(`[Notification] Found ${routeUsers.length} route users assigned to route ${routeId}`);

			// Bulk-fetch existing subscriptions for this bus to reduce O(U) queries
			const existingSubs = await BusSubscription.find({
				organizationId: toObjectId(input.organizationId),
				busId: toObjectId(input.busId),
			});
			const subMap = new Map(existingSubs.map(s => [s.userId.toString(), s]));

			for (const u of routeUsers) {
				try {
					const existingSub = subMap.get(u._id.toString());

					if (!existingSub) {
						await BusSubscription.create({
							organizationId: toObjectId(input.organizationId),
							userId: u._id,
							busId: toObjectId(input.busId),
							stopId: u.stopId,
							notifyOnBusStart: true,
							notifyOnNearStop: true,
							nearRadiusMeters: 500, // Safe default threshold
							isActive: true,
						});
						logger.info(`[Notification] Created implicit BusSubscription for user ${u.name} (ID: ${u._id}) on route ${routeId}`);
					} else {
						// Sync stopId if it has changed in user profile
						let subUpdated = false;
						if (!existingSub.isActive) {
							existingSub.isActive = true;
							subUpdated = true;
						}
						if (!existingSub.stopId || existingSub.stopId.toString() !== u.stopId?.toString()) {
							existingSub.stopId = u.stopId;
							subUpdated = true;
						}
						if (subUpdated) {
							await existingSub.save();
							logger.info(`[Notification] Synchronized BusSubscription settings for user ${u.name} (ID: ${u._id})`);
						}
					}
				} catch (syncError) {
					logger.error(`[Notification] Error syncing implicit subscription for user ${u.name} (ID: ${u._id}):`, syncError);
				}
			}
		} catch (subError) {
			logger.error('[Notification] Error resolving implicit route subscriptions:', subError);
		}

		// 4. Query stops on route to calculate progression
		const stops = await Stop.find({
			organizationId: toObjectId(input.organizationId),
			routeId: routeId,
		}).sort({ sequenceOrder: 1 }).select('_id name latitude longitude sequenceOrder radiusMeters');

		if (stops.length === 0) {
			logger.warn(`[Notification] No stops found on route ${routeId}`);
			return;
		}

		// Calculate nearest stop to update last reached stop progression
		let closestStop = stops[0];
		let closestStopDist = Number.MAX_VALUE;
		for (const stop of stops) {
			const dist = calculateDistanceMeters(input.latitude, input.longitude, stop.latitude, stop.longitude);
			if (dist < closestStopDist) {
				closestStopDist = dist;
				closestStop = stop;
			}
		}

		// Fetch last reached stop sequence from Redis
		const redis = redisService.getClient();
		const redisSeqKey = `trip:${activeTrip._id}:last_reached_stop_sequence`;
		const cachedSeqStr = await redis.get(redisSeqKey);
		let lastReachedSeq = cachedSeqStr ? parseInt(cachedSeqStr, 10) : 0;

		// Auto-advance sequence order based on proximity
		lastReachedSeq = Math.max(lastReachedSeq, closestStop.sequenceOrder - 1);
		if (closestStopDist <= 100) { // 100m is stop reached threshold
			lastReachedSeq = Math.max(lastReachedSeq, closestStop.sequenceOrder);
		}
		await redis.setex(redisSeqKey, 86400, String(lastReachedSeq));

		logger.info(`[ROUTE VALIDATION] tripId=${activeTrip._id}, routeId=${routeId}, closestStop=${closestStop.name}, sequenceOrder=${closestStop.sequenceOrder}, lastReachedSeq=${lastReachedSeq}`);

		// Get previous bus location from Redis to calculate approaching vector
		const redisLocationKey = `trip:${activeTrip._id}:last_location`;
		const cachedLocStr = await redis.get(redisLocationKey);
		let prevLat: number | null = null;
		let prevLng: number | null = null;
		if (cachedLocStr) {
			try {
				const parsed = JSON.parse(cachedLocStr);
				prevLat = parsed.latitude;
				prevLng = parsed.longitude;
				logger.info(`[REDIS LOCATION] tripId=${activeTrip._id}, lastLat=${prevLat}, lastLng=${prevLng}`);
			} catch (e) {
				logger.warn('[Notification] Failed to parse cached location from Redis');
			}
		}

		// Query all active subscriptions
		const subscriptions = await BusSubscription.find({
			organizationId: toObjectId(input.organizationId),
			busId: toObjectId(input.busId),
			isActive: true,
		}).populate('stopId', 'name latitude longitude radiusMeters sequenceOrder');

		logger.info(`[Notification] Found ${subscriptions.length} active subscriptions for busId=${input.busId}`);

		if (subscriptions.length === 0) {
			// Save current location as last location and exit
			await redis.setex(redisLocationKey, 86400, JSON.stringify({ latitude: input.latitude, longitude: input.longitude, timestamp: new Date() }));
			return;
		}

		// Perform bulk lookups to eliminate O(S) query overhead in the loop
		const subscriberUserIds = subscriptions.map(s => s.userId);
		
		// 1. Bulk User details & notification preferences
		const usersWithPrefs = await User.find({
			_id: { $in: subscriberUserIds },
			organizationId: toObjectId(input.organizationId),
		})
		.select('_id name stopId notificationPreferences')
		.populate('stopId', 'name');
		const userMap = new Map(usersWithPrefs.map(u => [u._id.toString(), u]));

		// 2. Bulk User Device tokens
		const allDeviceTokens = await DeviceToken.find({
			userId: { $in: subscriberUserIds },
			isActive: true,
		}).select('userId deviceToken');
		const tokenMap = new Map<string, string[]>();
		for (const t of allDeviceTokens) {
			const uid = t.userId.toString();
			if (!tokenMap.has(uid)) {
				tokenMap.set(uid, []);
			}
			tokenMap.get(uid)!.push(t.deviceToken);
		}

		// Evaluate and send notifications
		for (const subscription of subscriptions) {
			try {
				let updatedSubscription = false;
				const userId = subscription.userId.toString();
				const deviceTokens = tokenMap.get(userId) || [];

				logger.info(`[Notification] Processing subscription for userId=${userId} — found ${deviceTokens.length} active device tokens`);

				if (deviceTokens.length === 0) {
					continue;
				}

				// Resolve user details & preferences
				const userObj = userMap.get(userId);
				const userName = userObj?.name || 'Passenger';
				const userStopObj = userObj?.stopId as any;
				const userStopName = userStopObj?.name || 'your stop';
				const prefs = userObj?.notificationPreferences;
				const userPrefs = {
					tripStartedEnabled: prefs?.tripStartedEnabled ?? true,
					busNearStopEnabled: prefs?.busNearStopEnabled ?? true,
					busArrivedEnabled: prefs?.busArrivedEnabled ?? true,
					delayAlertsEnabled: prefs?.delayAlertsEnabled ?? true,
				};
				logger.info(`[Notification] Preferences for user ${userId} (${userName}): start=${userPrefs.tripStartedEnabled}, near=${userPrefs.busNearStopEnabled}, arrived=${userPrefs.busArrivedEnabled}`);

				// Bus Started Alert
				if (input.isBusStartedEvent && subscription.notifyOnBusStart) {
					if (!userPrefs.tripStartedEnabled) {
						logger.info(`[Notification] User ${userId} has disabled trip start alerts. Skipping.`);
					} else {
						const title = 'Bus started';
						const message = `Bus ${input.busNumberPlate} on Route ${routeName} has started.`;
						const voiceMessage = `Dear ${userName}, your bus has started.`;

						logger.info(`[USERNAME] ${userName}`);
						logger.info(`[VOICE PAYLOAD GENERATED] voiceMessage="${voiceMessage}"`);

						try {
							logger.info(`[Notification] Creating BUS_STARTED DB record for user ${userId}`);
							await Notification.create({
								organizationId: subscription.organizationId,
								userId: subscription.userId,
								busId: subscription.busId,
								type: NOTIFICATION_TYPES.BUS_STARTED,
								title,
								message,
								voiceMessage,
								payload: {
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									latitude: input.latitude,
									longitude: input.longitude,
								},
							});
						} catch (dbError) {
							logger.error(`[Notification] Failed to create BUS_STARTED DB record for user ${userId}:`, dbError);
						}

						for (const token of deviceTokens) {
							try {
								const fcmPayload = {
									fcmToken: token,
									title,
									body: message,
									data: {
										type: NOTIFICATION_TYPES.BUS_STARTED,
										notificationType: NOTIFICATION_TYPES.BUS_STARTED,
										busId: input.busId,
										tripId: String(activeTrip._id),
										numberPlate: input.busNumberPlate,
										voiceMessage,
									},
								};
								logger.info(`[FCM PAYLOAD] ${JSON.stringify(fcmPayload)}`);
								await sendPushNotification(fcmPayload);
								logger.info(`[FCM SENT] token=${token.substring(0, 15)}...`);
							} catch (error: any) {
								const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
								const errorCode = error?.code || '';
								logger.error(
									`[FCM FAILURE] token=${token.substring(0, 15)}..., errorCode=${errorCode}, error=${errorMessage}`
								);
								if (
									errorCode === 'messaging/registration-token-not-registered' ||
									errorCode === 'messaging/invalid-argument' ||
									errorCode === 'messaging/mismatched-credential' ||
									errorMessage.includes('not registered') ||
									errorMessage.includes('invalid') ||
									errorMessage.includes('requested entity was not found') ||
									errorMessage.includes('mismatched credential') ||
									errorMessage.includes('sender id mismatch')
								) {
									await notificationService.deactivateDeviceToken(token);
								}
							}
						}

						subscription.lastStartNotifiedAt = new Date();
						updatedSubscription = true;
					}
				}

				// Proximity & Arrival alerts
				if (subscription.notifyOnNearStop) {
					const stop = subscription.stopId as any;
					const targetLat =
						typeof subscription.userLatitude === 'number'
							? subscription.userLatitude
							: typeof stop?.latitude === 'number'
							  ? stop.latitude
							  : null;

					const targetLng =
						typeof subscription.userLongitude === 'number'
							? subscription.userLongitude
							: typeof stop?.longitude === 'number'
							  ? stop.longitude
							  : null;

					const stopName = stop?.name || userStopName || 'your location';
					const stopSequence = typeof stop?.sequenceOrder === 'number' ? stop.sequenceOrder : 0;

					if (targetLat !== null && targetLng !== null) {
						const currentDistance = calculateDistanceMeters(
							input.latitude,
							input.longitude,
							targetLat,
							targetLng
						);

						const previousDistance = (prevLat !== null && prevLng !== null)
							? calculateDistanceMeters(prevLat, prevLng, targetLat, targetLng)
							: null;

						logger.info(`[DISTANCE CALCULATION] user=${userId}, stop=${stopName}, dist=${Math.round(currentDistance)}m, prevDist=${previousDistance !== null ? Math.round(previousDistance) + 'm' : 'none'}`);

						// Enforce trigger distance rules: minimum 500m (configurable)
						const radius = Math.max(
							subscription.nearRadiusMeters || 0,
							typeof stop?.radiusMeters === 'number' ? stop.radiusMeters : 0,
							500
						);

						// Determine approaching vector direction
						const isApproaching = previousDistance === null || currentDistance < previousDistance;
						logger.info(`[APPROACHING STOP] user=${userId}, stop=${stopName}, approaching=${isApproaching}`);

						// Near Stop Alert Checks
						if (currentDistance <= radius) {
							const canNotifyNearStop =
								!subscription.lastNearStopNotifiedAt ||
								Date.now() - new Date(subscription.lastNearStopNotifiedAt).getTime() >=
									NEAR_STOP_COOLDOWN_MS;

							if (!canNotifyNearStop) {
								logger.info(`[COOLDOWN ACTIVE] user=${userId}, type=BUS_NEAR_STOP, lastNotifiedAt=${subscription.lastNearStopNotifiedAt}`);
							} else if (!userPrefs.busNearStopEnabled) {
								logger.info(`[Notification] User ${userId} has disabled near stop alerts. Skipping.`);
							} else if (lastReachedSeq < stopSequence - 1) {
								logger.info(`[Notification] Route progression blocked: bus has not reached previous stop for ${stopName} (sequence: ${stopSequence}, lastReachedSeq: ${lastReachedSeq})`);
							} else if (lastReachedSeq >= stopSequence) {
								logger.info(`[Notification] Route progression blocked: bus has already reached or passed ${stopName} (sequence: ${stopSequence}, lastReachedSeq: ${lastReachedSeq})`);
							} else if (!isApproaching) {
								logger.info(`[Notification] Direction validation blocked: bus is not approaching ${stopName}`);
							} else {
								const title = 'Bus is nearby';
								const message = `Bus ${input.busNumberPlate} is near ${stopName}`;
								const voiceMessage = `Dear ${userName}, your bus is approaching ${stopName}. Please be ready.`;

								logger.info(`[USERNAME] ${userName}`);
								logger.info(`[STOP NAME] ${stopName}`);
								logger.info(`[VOICE PAYLOAD GENERATED] voiceMessage="${voiceMessage}"`);
								logger.info(`[BUS NEAR STOP TRIGGERED] user=${userId}, stop=${stopName}, distance=${Math.round(currentDistance)}m`);

								try {
									await Notification.create({
										organizationId: subscription.organizationId,
										userId: subscription.userId,
										busId: subscription.busId,
										stopId: stop?._id || null,
										type: NOTIFICATION_TYPES.BUS_NEAR_STOP,
										title,
										message,
										voiceMessage,
										payload: {
											busId: input.busId,
											numberPlate: input.busNumberPlate,
											latitude: input.latitude,
											longitude: input.longitude,
											targetLatitude: targetLat,
											targetLongitude: targetLng,
											distanceMeters: Math.round(currentDistance),
											radiusMeters: radius,
										},
									});
								} catch (dbError) {
									logger.error(`[Notification] Failed to create BUS_NEAR_STOP DB record for user ${userId}:`, dbError);
								}

								for (const token of deviceTokens) {
									try {
										const fcmPayload = {
											fcmToken: token,
											title,
											body: message,
											data: {
												type: NOTIFICATION_TYPES.BUS_NEAR_STOP,
												notificationType: NOTIFICATION_TYPES.BUS_NEAR_STOP,
												busId: input.busId,
												tripId: String(activeTrip._id),
												numberPlate: input.busNumberPlate,
												stopName,
												distanceMeters: String(Math.round(currentDistance)),
												voiceMessage,
											},
										};
										logger.info(`[FCM PAYLOAD] ${JSON.stringify(fcmPayload)}`);
										await sendPushNotification(fcmPayload);
										logger.info(`[FCM SENT] token=${token.substring(0, 15)}...`);
									} catch (error: any) {
										const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
										const errorCode = error?.code || '';
										logger.error(
											`[FCM FAILURE] token=${token.substring(0, 15)}..., errorCode=${errorCode}, error=${errorMessage}`
										);
										if (
											errorCode === 'messaging/registration-token-not-registered' ||
											errorCode === 'messaging/invalid-argument' ||
											errorCode === 'messaging/mismatched-credential' ||
											errorMessage.includes('not registered') ||
											errorMessage.includes('invalid') ||
											errorMessage.includes('requested entity was not found') ||
											errorMessage.includes('mismatched credential') ||
											errorMessage.includes('sender id mismatch')
										) {
											await notificationService.deactivateDeviceToken(token);
										}
									}
								}

								subscription.lastNearStopNotifiedAt = new Date();
								updatedSubscription = true;
							}
						}

						// Bus Arrived Alert Checks (100m threshold)
						if (currentDistance <= ARRIVED_THRESHOLD_M) {
							const canNotifyArrived =
								!subscription.lastArrivedNotifiedAt ||
								Date.now() - new Date(subscription.lastArrivedNotifiedAt).getTime() >=
									ARRIVED_COOLDOWN_MS;

							if (!canNotifyArrived) {
								logger.info(`[COOLDOWN ACTIVE] user=${userId}, type=BUS_ARRIVED, lastNotifiedAt=${subscription.lastArrivedNotifiedAt}`);
							} else if (!userPrefs.busArrivedEnabled) {
								logger.info(`[Notification] User ${userId} has disabled arrived alerts. Skipping.`);
							} else if (lastReachedSeq < stopSequence) {
								logger.info(`[BUS ARRIVED TRIGGERED] user=${userId}, stop=${stopName}`);

								const arrivedTitle = 'Bus Arrived';
								const arrivedMessage = `Bus ${input.busNumberPlate} has arrived at ${stopName}`;
								const voiceMessage = `Dear ${userName}, your bus has arrived at ${stopName}.`;

								logger.info(`[USERNAME] ${userName}`);
								logger.info(`[STOP NAME] ${stopName}`);
								logger.info(`[VOICE PAYLOAD GENERATED] voiceMessage="${voiceMessage}"`);

								try {
									await Notification.create({
										organizationId: subscription.organizationId,
										userId: subscription.userId,
										busId: subscription.busId,
										stopId: stop?._id || null,
										type: NOTIFICATION_TYPES.BUS_ARRIVED,
										title: arrivedTitle,
										message: arrivedMessage,
										voiceMessage,
										payload: {
											busId: input.busId,
											numberPlate: input.busNumberPlate,
											latitude: input.latitude,
											longitude: input.longitude,
											stopName,
										},
									});
								} catch (dbError) {
									logger.error(`[Notification] Failed to create BUS_ARRIVED DB record for user ${userId}:`, dbError);
								}

								for (const token of deviceTokens) {
									try {
										const fcmPayload = {
											fcmToken: token,
											title: arrivedTitle,
											body: arrivedMessage,
											data: {
												type: NOTIFICATION_TYPES.BUS_ARRIVED,
												notificationType: NOTIFICATION_TYPES.BUS_ARRIVED,
												busId: input.busId,
												tripId: String(activeTrip._id),
												numberPlate: input.busNumberPlate,
												stopName,
												voiceMessage,
											},
										};
										logger.info(`[FCM PAYLOAD] ${JSON.stringify(fcmPayload)}`);
										await sendPushNotification(fcmPayload);
										logger.info(`[FCM SENT] token=${token.substring(0, 15)}...`);
									} catch (error: any) {
										const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
										const errorCode = error?.code || '';
										logger.error(
											`[FCM FAILURE] token=${token.substring(0, 15)}..., errorCode=${errorCode}, error=${errorMessage}`
										);
										if (
											errorCode === 'messaging/registration-token-not-registered' ||
											errorCode === 'messaging/invalid-argument' ||
											errorCode === 'messaging/mismatched-credential' ||
											errorMessage.includes('not registered') ||
											errorMessage.includes('invalid') ||
											errorMessage.includes('requested entity was not found') ||
											errorMessage.includes('mismatched credential') ||
											errorMessage.includes('sender id mismatch')
										) {
											await notificationService.deactivateDeviceToken(token);
										}
									}
								}

								subscription.lastArrivedNotifiedAt = new Date();
								updatedSubscription = true;
							}
						}
					} else {
						logger.warn(`[Notification] Coordinates missing for user ${userId} or stop`);
					}
				}

				if (updatedSubscription) {
					await subscription.save();
				}
			} catch (subError) {
				logger.error(`[Notification] Error processing subscription in loop:`, subError);
			}
		}

		// Save current location as last location for the next update
		await redis.setex(redisLocationKey, 86400, JSON.stringify({ latitude: input.latitude, longitude: input.longitude, timestamp: new Date() }));
	},

	// FCM Device Token Management
	registerDeviceToken: async (
		userId: string,
		deviceToken: string,
		deviceType: 'ios' | 'android' | 'web'
	) => {
		try {
			logger.info(`registerDeviceToken initiated - userId: ${userId}, deviceType: ${deviceType}, token: ${deviceToken.substring(0, 15)}...`);

			// Find existing token record (since deviceToken is unique)
			const existing = await DeviceToken.findOne({ deviceToken });

			if (existing) {
				existing.userId = toObjectId(userId) as any;
				existing.deviceType = deviceType;
				existing.isActive = true;
				existing.lastUsedAt = new Date();
				const updatedDoc = await existing.save();

				logger.info(`Device token updated successfully - userId: ${userId}, deviceType: ${deviceType}, docId: ${updatedDoc._id}, lastUsedAt: ${updatedDoc.lastUsedAt}`);
				return true;
			}

			// Create a new device token record if not exists
			const newDoc = await DeviceToken.create({
				userId: toObjectId(userId) as any,
				deviceToken,
				deviceType,
				isActive: true,
				lastUsedAt: new Date(),
			});

			logger.info(`Device token created successfully - userId: ${userId}, deviceType: ${deviceType}, docId: ${newDoc._id}`);
			return true;
		} catch (error) {
			logger.error(`Error registering device token for userId: ${userId}, error:`, error);
			return false;
		}
	},

	deactivateDeviceToken: async (deviceToken: string) => {
		try {
			await DeviceToken.updateOne({ deviceToken }, { isActive: false });
			logger.info(`Device token deactivated: ${deviceToken}`);
			return true;
		} catch (error) {
			logger.error('Error deactivating device token:', error);
			return false;
		}
	},

	getUserDeviceTokens: async (userId: string): Promise<string[]> => {
		try {
			const tokens = await DeviceToken.find({
				userId: toObjectId(userId),
				isActive: true,
			} as any).select('deviceToken');

			return tokens.map((t) => t.deviceToken);
		} catch (error) {
			logger.error('Error fetching device tokens:', error);
			return [];
		}
	},

	// Get User Notification Preferences
	getUserPreferences: async (userId: string) => {
		try {
			const user = await User.findById(userId).select('notificationPreferences');

			if (!user?.notificationPreferences) {
				return {
					tripStartedEnabled: true,
					busNearStopEnabled: true,
					busArrivedEnabled: true,
					delayAlertsEnabled: true,
				};
			}

			return {
				tripStartedEnabled: user.notificationPreferences.tripStartedEnabled ?? true,
				busNearStopEnabled: user.notificationPreferences.busNearStopEnabled ?? true,
				busArrivedEnabled: user.notificationPreferences.busArrivedEnabled ?? true,
				delayAlertsEnabled: user.notificationPreferences.delayAlertsEnabled ?? true,
			};
		} catch (error) {
			logger.error('Error fetching user preferences:', error);
			return {
				tripStartedEnabled: true,
				busNearStopEnabled: true,
				busArrivedEnabled: true,
				delayAlertsEnabled: true,
			};
		}
	},

	/**
	 * Handle trip started — notify all users with stops on this route or bus subscription
	 */
	handleTripStarted: async (input: {
		organizationId: string;
		busId: string;
		busNumberPlate: string;
		tripId: string;
		routeId: string;
	}) => {
		try {
			logger.info(`[Notification] handleTripStarted event triggered: busId=${input.busId}, plate=${input.busNumberPlate}, tripId=${input.tripId}`);

			// Reset cooldowns for all subscriptions of this bus upon starting a new trip
			try {
				await BusSubscription.updateMany(
					{ busId: toObjectId(input.busId), organizationId: toObjectId(input.organizationId) },
					{
						$set: {
							lastStartNotifiedAt: null,
							lastNearStopNotifiedAt: null,
							lastArrivedNotifiedAt: null,
						}
					}
				);
				logger.info(`[Notification] Reset cooldowns for all subscriptions of busId=${input.busId}`);
			} catch (resetError) {
				logger.error('[Notification] Error resetting subscription cooldowns:', resetError);
			}

			// Find all users assigned to this route with an assigned stop
			const routeUserIds = input.routeId ? await User.find({
				organizationId: toObjectId(input.organizationId),
				routeId: toObjectId(input.routeId),
				stopId: { $exists: true, $ne: null },
			}).distinct('_id') : [];

			// Find all users with active subscriptions for this bus
			const subUserIds = await BusSubscription.find({
				organizationId: toObjectId(input.organizationId),
				busId: toObjectId(input.busId),
				isActive: true,
			}).distinct('userId');

			// Combine them to get a unique list of user IDs
			const uniqueUserIds = Array.from(
				new Set([
					...routeUserIds.map((id: any) => id.toString()),
					...subUserIds.map((id: any) => id.toString()),
				])
			);

			logger.info(`[Notification] Found ${routeUserIds.length} route users and ${subUserIds.length} active subscribers. Combined: ${uniqueUserIds.length} unique users.`);

			if (uniqueUserIds.length === 0) {
				return;
			}

			const route = await Route.findById(input.routeId).select('name').lean();
			const routeName = route?.name || 'Unknown Route';

			const users = await User.find({
				_id: { $in: uniqueUserIds.map(toObjectId) },
				organizationId: toObjectId(input.organizationId),
			})
			.select('_id name stopId notificationPreferences')
			.populate('stopId', 'name');

			let notifiedCount = 0;

			for (const user of users) {
				try {
					const userId = user._id.toString();
					const prefs = user.notificationPreferences;
					
					// preference check
					if (prefs && prefs.tripStartedEnabled === false) {
						logger.info(`[Notification] User ${user.name} (ID: ${userId}) has disabled trip start alerts. Skipping.`);
						continue;
					}

					const userName = user.name || 'Passenger';
					const userStopObj = user.stopId as any;
					const stopName = userStopObj?.name || '';

					const voiceMessage = `Dear ${userName}, your bus has started.`;
					const title = 'Trip Started';
					const message = `Bus ${input.busNumberPlate} on Route ${routeName} has started its trip. Track it live!`;

					logger.info(`[USERNAME] ${userName}`);
					if (stopName) {
						logger.info(`[STOP NAME] ${stopName}`);
					}
					logger.info(`[VOICE PAYLOAD GENERATED] voiceMessage="${voiceMessage}"`);

					try {
						logger.info(`[Notification] Creating TRIP_STARTED DB record for user ${user.name} (ID: ${userId})`);
						await Notification.create({
							organizationId: toObjectId(input.organizationId),
							userId: user._id,
							busId: toObjectId(input.busId),
							tripId: toObjectId(input.tripId),
							type: NOTIFICATION_TYPES.TRIP_STARTED,
							title,
							message,
							voiceMessage,
							payload: {
								busId: input.busId,
								numberPlate: input.busNumberPlate,
								tripId: input.tripId,
								routeId: input.routeId,
							},
						});
					} catch (dbError) {
						logger.error(`[Notification] Failed to create TRIP_STARTED DB record for user ${userId}:`, dbError);
					}

					const deviceTokens = await notificationService.getUserDeviceTokens(userId);
					logger.info(`[Notification] User ${user.name} (ID: ${userId}) has ${deviceTokens.length} active device tokens`);

					for (const token of deviceTokens) {
						try {
							const fcmPayload = {
								fcmToken: token,
								title,
								body: message,
								data: {
									type: NOTIFICATION_TYPES.TRIP_STARTED,
									notificationType: NOTIFICATION_TYPES.TRIP_STARTED,
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									tripId: input.tripId,
									voiceMessage,
								},
							};
							logger.info(`[FCM PAYLOAD] ${JSON.stringify(fcmPayload)}`);
							await sendPushNotification(fcmPayload);
							logger.info(`[FCM SENT] token=${token.substring(0, 15)}...`);
						} catch (error: any) {
							const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
							const errorCode = error?.code || '';
							logger.error(
								`[Notification] Failed to send FCM push - userId: ${userId}, token: ${token}, type: ${NOTIFICATION_TYPES.TRIP_STARTED}, errorCode: ${errorCode}, error: ${error instanceof Error ? error.message : String(error)}`
							);
							if (
								errorCode === 'messaging/registration-token-not-registered' ||
								errorCode === 'messaging/invalid-argument' ||
								errorCode === 'messaging/mismatched-credential' ||
								errorMessage.includes('not registered') ||
								errorMessage.includes('invalid') ||
								errorMessage.includes('requested entity was not found') ||
								errorMessage.includes('mismatched credential') ||
								errorMessage.includes('sender id mismatch')
							) {
								await notificationService.deactivateDeviceToken(token);
							}
						}
					}
					notifiedCount++;
				} catch (userError) {
					logger.error(`[Notification] Error processing user ${user._id} in handleTripStarted loop:`, userError);
				}
			}

			logger.info(`[Notification] Trip started notifications successfully processed for ${notifiedCount}/${users.length} users`);
		} catch (error) {
			logger.error('[Notification] handleTripStarted error:', error);
		}
	},

	/**
	 * Handle trip completed — notify subscribed users and route users
	 */
	handleTripCompleted: async (input: {
		organizationId: string;
		busId: string;
		busNumberPlate: string;
		tripId: string;
		routeId: string;
	}) => {
		try {
			logger.info(`[Notification] handleTripCompleted event triggered: busId=${input.busId}, plate=${input.busNumberPlate}, tripId=${input.tripId}`);

			// Find all users assigned to this route with an assigned stop
			const routeUserIds = input.routeId ? await User.find({
				organizationId: toObjectId(input.organizationId),
				routeId: toObjectId(input.routeId),
				stopId: { $exists: true, $ne: null },
			}).distinct('_id') : [];

			// Find all users with active subscriptions for this bus
			const subUserIds = await BusSubscription.find({
				organizationId: toObjectId(input.organizationId),
				busId: toObjectId(input.busId),
				isActive: true,
			}).distinct('userId');

			// Combine them to get a unique list of user IDs
			const uniqueUserIds = Array.from(
				new Set([
					...routeUserIds.map((id: any) => id.toString()),
					...subUserIds.map((id: any) => id.toString()),
				])
			);

			logger.info(`[Notification] Found ${routeUserIds.length} route users and ${subUserIds.length} active subscribers. Combined: ${uniqueUserIds.length} unique users to notify for trip completed.`);

			if (uniqueUserIds.length === 0) {
				return;
			}

			const route = await Route.findById(input.routeId).select('name').lean();
			const routeName = route?.name || 'Unknown Route';

			const users = await User.find({
				_id: { $in: uniqueUserIds.map(toObjectId) },
				organizationId: toObjectId(input.organizationId),
			})
			.select('_id name stopId notificationPreferences')
			.populate('stopId', 'name');

			let notifiedCount = 0;

			for (const user of users) {
				try {
					const userId = user._id.toString();

					const userName = user.name || 'Passenger';
					const userStopObj = user.stopId as any;
					const stopName = userStopObj?.name || '';

					const voiceMessage = `Dear ${userName}, your trip has been completed.`;
					const title = 'Trip Completed';
					const message = `Bus ${input.busNumberPlate} on Route ${routeName} has completed its trip.`;

					logger.info(`[USERNAME] ${userName}`);
					if (stopName) {
						logger.info(`[STOP NAME] ${stopName}`);
					}
					logger.info(`[VOICE PAYLOAD GENERATED] voiceMessage="${voiceMessage}"`);

					try {
						logger.info(`[Notification] Creating TRIP_COMPLETED DB record for user ${user.name} (ID: ${userId})`);
						await Notification.create({
							organizationId: toObjectId(input.organizationId),
							userId: user._id,
							busId: toObjectId(input.busId),
							tripId: toObjectId(input.tripId),
							type: NOTIFICATION_TYPES.TRIP_COMPLETED,
							title,
							message,
							voiceMessage,
							payload: {
								busId: input.busId,
								numberPlate: input.busNumberPlate,
								tripId: input.tripId,
								routeId: input.routeId,
							},
						});
					} catch (dbError) {
						logger.error(`[Notification] Failed to create TRIP_COMPLETED DB record for user ${userId}:`, dbError);
					}

					const deviceTokens = await notificationService.getUserDeviceTokens(userId);
					logger.info(`[Notification] User ${user.name} (ID: ${userId}) has ${deviceTokens.length} active device tokens`);

					for (const token of deviceTokens) {
						try {
							const fcmPayload = {
								fcmToken: token,
								title,
								body: message,
								data: {
									type: NOTIFICATION_TYPES.TRIP_COMPLETED,
									notificationType: NOTIFICATION_TYPES.TRIP_COMPLETED,
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									tripId: input.tripId,
									voiceMessage,
								},
							};
							logger.info(`[FCM PAYLOAD] ${JSON.stringify(fcmPayload)}`);
							await sendPushNotification(fcmPayload);
							logger.info(`[FCM SENT] token=${token.substring(0, 15)}...`);
						} catch (error: any) {
							const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
							const errorCode = error?.code || '';
							logger.error(
								`[Notification] Failed to send FCM push - userId: ${userId}, token: ${token}, type: ${NOTIFICATION_TYPES.TRIP_COMPLETED}, errorCode: ${errorCode}, error: ${error instanceof Error ? error.message : String(error)}`
							);
							if (
								errorCode === 'messaging/registration-token-not-registered' ||
								errorCode === 'messaging/invalid-argument' ||
								errorCode === 'messaging/mismatched-credential' ||
								errorMessage.includes('not registered') ||
								errorMessage.includes('invalid') ||
								errorMessage.includes('requested entity was not found') ||
								errorMessage.includes('mismatched credential') ||
								errorMessage.includes('sender id mismatch')
							) {
								await notificationService.deactivateDeviceToken(token);
							}
						}
					}
					notifiedCount++;
				} catch (userError) {
					logger.error(`[Notification] Error processing user ${user._id} in handleTripCompleted loop:`, userError);
				}
			}

			logger.info(`[Notification] Trip completed notifications processed for ${notifiedCount}/${users.length} users`);
		} catch (error) {
			logger.error('[Notification] handleTripCompleted error:', error);
		}
	},

	/**
	 * Handle delay alert — notify route users and subscribers
	 */
	handleDelayAlert: async (input: {
		organizationId: string;
		busId: string;
		busNumberPlate: string;
		tripId: string;
		routeId: string;
		delayMinutes: number;
		reason?: string;
	}) => {
		try {
			logger.info(`[Notification] handleDelayAlert event triggered: busId=${input.busId}, delay=${input.delayMinutes}min`);

			// Find all users assigned to this route with an assigned stop
			const routeUserIds = input.routeId ? await User.find({
				organizationId: toObjectId(input.organizationId),
				routeId: toObjectId(input.routeId),
				stopId: { $exists: true, $ne: null },
			}).distinct('_id') : [];

			// Find all users with active subscriptions for this bus
			const subUserIds = await BusSubscription.find({
				organizationId: toObjectId(input.organizationId),
				busId: toObjectId(input.busId),
				isActive: true,
			}).distinct('userId');

			// Combine them to get a unique list of user IDs
			const uniqueUserIds = Array.from(
				new Set([
					...routeUserIds.map((id: any) => id.toString()),
					...subUserIds.map((id: any) => id.toString()),
				])
			);

			logger.info(`[Notification] Found ${routeUserIds.length} route users and ${subUserIds.length} active subscribers. Combined: ${uniqueUserIds.length} unique users to notify for delay alert.`);

			if (uniqueUserIds.length === 0) {
				return;
			}

			const route = await Route.findById(input.routeId).select('name').lean();
			const routeName = route?.name || 'Unknown Route';

			const users = await User.find({
				_id: { $in: uniqueUserIds.map(toObjectId) },
				organizationId: toObjectId(input.organizationId),
			})
			.select('_id name stopId notificationPreferences')
			.populate('stopId', 'name');

			let notifiedCount = 0;

			for (const user of users) {
				try {
					const userId = user._id.toString();
					const prefs = user.notificationPreferences;
					if (prefs && prefs.delayAlertsEnabled === false) {
						logger.info(`[Notification] User ${user.name} (ID: ${userId}) has disabled delay alerts. Skipping.`);
						continue;
					}

					const userName = user.name || 'Passenger';
					const userStopObj = user.stopId as any;
					const stopName = userStopObj?.name || '';

					const voiceMessage = `Dear ${userName}, your bus is delayed by ${input.delayMinutes} minutes.`;
					const title = 'Bus Delayed';
					const message = `Bus ${input.busNumberPlate} on Route ${routeName} is delayed by ~${input.delayMinutes} minutes.${input.reason ? ' ' + input.reason : ''}`;

					logger.info(`[USERNAME] ${userName}`);
					if (stopName) {
						logger.info(`[STOP NAME] ${stopName}`);
					}
					logger.info(`[VOICE PAYLOAD GENERATED] voiceMessage="${voiceMessage}"`);

					try {
						logger.info(`[Notification] Creating DELAY_ALERT DB record for user ${user.name} (ID: ${userId})`);
						await Notification.create({
							organizationId: toObjectId(input.organizationId),
							userId: user._id,
							busId: toObjectId(input.busId),
							tripId: toObjectId(input.tripId),
							type: NOTIFICATION_TYPES.DELAY_ALERT,
							title,
							message,
							voiceMessage,
							payload: {
								busId: input.busId,
								numberPlate: input.busNumberPlate,
								tripId: input.tripId,
								delayMinutes: String(input.delayMinutes),
							},
						});
					} catch (dbError) {
						logger.error(`[Notification] Failed to create DELAY_ALERT DB record for user ${userId}:`, dbError);
					}

					const deviceTokens = await notificationService.getUserDeviceTokens(userId);
					logger.info(`[Notification] User ${user.name} (ID: ${userId}) has ${deviceTokens.length} active device tokens`);

					for (const token of deviceTokens) {
						try {
							const fcmPayload = {
								fcmToken: token,
								title,
								body: message,
								data: {
									type: NOTIFICATION_TYPES.DELAY_ALERT,
									notificationType: NOTIFICATION_TYPES.DELAY_ALERT,
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									tripId: input.tripId,
									delayMinutes: String(input.delayMinutes),
									voiceMessage,
								},
							};
							logger.info(`[FCM PAYLOAD] ${JSON.stringify(fcmPayload)}`);
							await sendPushNotification(fcmPayload);
							logger.info(`[FCM SENT] token=${token.substring(0, 15)}...`);
						} catch (error: any) {
							const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
							const errorCode = error?.code || '';
							logger.error(
								`[Notification] Failed to send FCM push - userId: ${userId}, token: ${token}, type: ${NOTIFICATION_TYPES.DELAY_ALERT}, errorCode: ${errorCode}, error: ${error instanceof Error ? error.message : String(error)}`
							);
							if (
								errorCode === 'messaging/registration-token-not-registered' ||
								errorCode === 'messaging/invalid-argument' ||
								errorCode === 'messaging/mismatched-credential' ||
								errorMessage.includes('not registered') ||
								errorMessage.includes('invalid') ||
								errorMessage.includes('requested entity was not found') ||
								errorMessage.includes('mismatched credential') ||
								errorMessage.includes('sender id mismatch')
							) {
								await notificationService.deactivateDeviceToken(token);
							}
						}
					}
					notifiedCount++;
				} catch (userError) {
					logger.error(`[Notification] Error processing user ${user._id} in handleDelayAlert loop:`, userError);
				}
			}

			logger.info(`[Notification] Delay alerts successfully processed for ${notifiedCount}/${users.length} users`);
		} catch (error) {
			logger.error('[Notification] handleDelayAlert error:', error);
		}
	},
};


