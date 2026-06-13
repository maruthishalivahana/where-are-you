import mongoose from 'mongoose';
import { NOTIFICATION_TYPES } from '../../constants/notificationTypes';
import { calculateDistanceMeters } from '../../utils/calculateDistance';
import { BusSubscription } from '../busSubscription/busSubscription.model';
import { Stop } from '../stop/stop.model';
import { Notification } from './notification.model';
import { User } from '../user/user.model';
import { Bus } from '../bus/bus.model';
import { sendPushNotification } from '../../utils/sendPushNotification';
import { DeviceToken } from './deviceToken.model';
import { logger } from '../../utils/logger';

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
	}) => {
		logger.info(`[Notification] processBusLocationUpdate initiated: busId=${input.busId}, plate=${input.busNumberPlate}, lat=${input.latitude}, lng=${input.longitude}, isStart=${input.isBusStartedEvent}`);

		// 1. Resolve implicit route-based subscriptions first
		try {
			const bus = await Bus.findOne({
				_id: toObjectId(input.busId),
				organizationId: toObjectId(input.organizationId),
			}).select('routeId');

			if (bus && bus.routeId) {
				logger.info(`[Notification] Bus ${input.busNumberPlate} route found: ${bus.routeId}. Resolving implicit subscriptions...`);

				const routeUsers = await User.find({
					organizationId: toObjectId(input.organizationId),
					routeId: bus.routeId,
					stopId: { $exists: true, $ne: null },
				}).select('_id name stopId');

				logger.info(`[Notification] Found ${routeUsers.length} route users assigned to route ${bus.routeId}`);

				for (const u of routeUsers) {
					try {
						const existingSub = await BusSubscription.findOne({
							organizationId: toObjectId(input.organizationId),
							userId: u._id,
							busId: bus._id,
						});

						if (!existingSub) {
							await BusSubscription.create({
								organizationId: toObjectId(input.organizationId),
								userId: u._id,
								busId: bus._id,
								stopId: u.stopId,
								notifyOnBusStart: true,
								notifyOnNearStop: true,
								nearRadiusMeters: 500, // Safe default threshold
								isActive: true,
							});
							logger.info(`[Notification] Created implicit BusSubscription for user ${u.name} (ID: ${u._id}) on route ${bus.routeId}`);
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
			} else {
				logger.warn(`[Notification] Bus ${input.busNumberPlate} has no assigned routeId`);
			}
		} catch (subError) {
			logger.error('[Notification] Error resolving implicit route subscriptions:', subError);
		}

		// 2. Query all active subscriptions for this bus
		const subscriptions = await BusSubscription.find({
			organizationId: toObjectId(input.organizationId),
			busId: toObjectId(input.busId),
			isActive: true,
		}).populate('stopId', 'name latitude longitude radiusMeters');

		logger.info(`[Notification] Found ${subscriptions.length} active subscriptions for busId=${input.busId}`);

		if (subscriptions.length === 0) {
			return;
		}

		for (const subscription of subscriptions) {
			try {
				let updatedSubscription = false;
				const userId = subscription.userId.toString();
				const deviceTokens = await notificationService.getUserDeviceTokens(userId);

				logger.info(`[Notification] Processing subscription for userId=${userId} — found ${deviceTokens.length} active device tokens`);

				if (deviceTokens.length === 0) {
					continue;
				}

				// Load user notification preferences to validate
				const userPrefs = await notificationService.getUserPreferences(userId);
				logger.info(`[Notification] Preferences for user ${userId}: start=${userPrefs.tripStartedEnabled}, near=${userPrefs.busNearStopEnabled}, arrived=${userPrefs.busArrivedEnabled}`);

				// Bus Started Alert
				if (input.isBusStartedEvent && subscription.notifyOnBusStart) {
					if (!userPrefs.tripStartedEnabled) {
						logger.info(`[Notification] User ${userId} has disabled trip start alerts. Skipping.`);
					} else {
						const title = 'Bus started';
						const message = `Bus ${input.busNumberPlate} has started`;
						const voiceMessage = `Bus ${input.busNumberPlate} has started.`;

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
								logger.info(`[Notification] Sending BUS_STARTED FCM to token: ${token.substring(0, 15)}...`);
								await sendPushNotification({
									fcmToken: token,
									title,
									body: message,
									data: {
										type: NOTIFICATION_TYPES.BUS_STARTED,
										busId: input.busId,
										numberPlate: input.busNumberPlate,
										voiceMessage,
									},
								});
							} catch (error: any) {
								const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
								const errorCode = error?.code || '';
								logger.error(
									`[Notification] Failed to send FCM push - userId: ${userId}, token: ${token}, type: ${NOTIFICATION_TYPES.BUS_STARTED}, errorCode: ${errorCode}, error: ${error instanceof Error ? error.message : String(error)}`
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

					const stopName = stop?.name || 'your location';

					if (targetLat !== null && targetLng !== null) {
						const distance = calculateDistanceMeters(
							input.latitude,
							input.longitude,
							targetLat,
							targetLng
						);

						// Enforce a minimum safe radius of 500m for near alerts
						const radius = Math.max(
							subscription.nearRadiusMeters || 0,
							typeof stop?.radiusMeters === 'number' ? stop.radiusMeters : 0,
							500
						);

						logger.info(`[Notification] Distance calculation: user/stop=${userId}/${stopName}, distance=${Math.round(distance)}m, radius=${radius}m`);

						const canNotifyNearStop =
							!subscription.lastNearStopNotifiedAt ||
							Date.now() - new Date(subscription.lastNearStopNotifiedAt).getTime() >=
								NEAR_STOP_COOLDOWN_MS;

						// Near Stop Alert
						if (distance <= radius) {
							if (!canNotifyNearStop) {
								logger.info(`[Notification] BUS_NEAR_STOP cooldown active for user ${userId}. Skipping.`);
							} else if (!userPrefs.busNearStopEnabled) {
								logger.info(`[Notification] User ${userId} has disabled near stop alerts. Skipping.`);
							} else {
								const title = 'Bus is nearby';
								const message = `Bus ${input.busNumberPlate} is near ${stopName}`;
								const voiceMessage = `Your bus is approaching ${stopName}. Please be ready.`;

								try {
									logger.info(`[Notification] Creating BUS_NEAR_STOP DB record for user ${userId}`);
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
											distanceMeters: Math.round(distance),
											radiusMeters: radius,
										},
									});
								} catch (dbError) {
									logger.error(`[Notification] Failed to create BUS_NEAR_STOP DB record for user ${userId}:`, dbError);
								}

								for (const token of deviceTokens) {
									try {
										logger.info(`[Notification] Sending BUS_NEAR_STOP FCM to token: ${token.substring(0, 15)}...`);
										await sendPushNotification({
											fcmToken: token,
											title,
											body: message,
											data: {
												type: NOTIFICATION_TYPES.BUS_NEAR_STOP,
												busId: input.busId,
												numberPlate: input.busNumberPlate,
												stopName,
												distanceMeters: String(Math.round(distance)),
												voiceMessage,
											},
										});
									} catch (error: any) {
										const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
										const errorCode = error?.code || '';
										logger.error(
											`[Notification] Failed to send FCM push - userId: ${userId}, token: ${token}, type: ${NOTIFICATION_TYPES.BUS_NEAR_STOP}, errorCode: ${errorCode}, error: ${error instanceof Error ? error.message : String(error)}`
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

						// Bus Arrived Alert
						if (distance <= ARRIVED_THRESHOLD_M) {
							const canNotifyArrived =
								!subscription.lastArrivedNotifiedAt ||
								Date.now() - new Date(subscription.lastArrivedNotifiedAt).getTime() >=
									ARRIVED_COOLDOWN_MS;

							if (!canNotifyArrived) {
								logger.info(`[Notification] BUS_ARRIVED cooldown active for user ${userId}. Skipping.`);
							} else if (!userPrefs.busArrivedEnabled) {
								logger.info(`[Notification] User ${userId} has disabled arrived alerts. Skipping.`);
							} else {
								const arrivedTitle = 'Bus Arrived';
								const arrivedMessage = `Bus ${input.busNumberPlate} has arrived at ${stopName}`;
								const voiceMessage = `Your bus has arrived at ${stopName}.`;

								try {
									logger.info(`[Notification] Creating BUS_ARRIVED DB record for user ${userId}`);
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
										logger.info(`[Notification] Sending BUS_ARRIVED FCM to token: ${token.substring(0, 15)}...`);
										await sendPushNotification({
											fcmToken: token,
											title: arrivedTitle,
											body: arrivedMessage,
											data: {
												type: NOTIFICATION_TYPES.BUS_ARRIVED,
												busId: input.busId,
												numberPlate: input.busNumberPlate,
												stopName,
												voiceMessage,
											},
										});
									} catch (error: any) {
										const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
										const errorCode = error?.code || '';
										logger.error(
											`[Notification] Failed to send FCM push - userId: ${userId}, token: ${token}, type: ${NOTIFICATION_TYPES.BUS_ARRIVED}, errorCode: ${errorCode}, error: ${error instanceof Error ? error.message : String(error)}`
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

	sendPushToUserDevices: async (
		userId: string,
		title: string,
		body: string,
		data: Record<string, string> = {}
	) => {
		try {
			const deviceTokens = await notificationService.getUserDeviceTokens(userId);
			if (deviceTokens.length === 0) {
				logger.warn(`No active device tokens found for user: ${userId}`);
				return;
			}
			for (const token of deviceTokens) {
				await sendPushNotification({
					fcmToken: token,
					title,
					body,
					data,
				});
			}
		} catch (error) {
			logger.error(`Error sending push to user devices (userId=${userId}):`, error);
		}
	},

	// Send Notification via FCM with Deduplication
	sendFCMNotification: async (input: {
		organizationId: string;
		userId: string;
		busId: string;
		tripId: string;
		type: string;
		title: string;
		body: string;
		voiceMessage: string;
		isSticky?: boolean;
		noSound?: boolean;
	}) => {
		try {
			// Get device tokens
			const deviceTokens = await notificationService.getUserDeviceTokens(input.userId);

			if (deviceTokens.length === 0) {
				logger.warn(`No device tokens found for user: ${input.userId}`);
				return { success: false, error: 'No device tokens' };
			}

			let successCount = 0;
			let failureCount = 0;

			for (const token of deviceTokens) {
				try {
					await sendPushNotification({
						fcmToken: token,
						title: input.title,
						body: input.body,
						data: {
							notificationType: input.type,
							tripId: input.tripId || '',
							busId: input.busId || '',
							voiceMessage: input.voiceMessage || '',
							isSticky: String(input.isSticky || false),
							noSound: String(input.noSound || false),
						},
					});
					successCount++;
				} catch (error) {
					failureCount++;
					logger.error(`FCM send failed for token ${token.substring(0, 15)}...:`, error);

					if (error instanceof Error && error.message.includes('invalid registration id')) {
						await notificationService.deactivateDeviceToken(token);
					}
				}
			}

			return {
				success: successCount > 0,
				successCount,
				failureCount,
			};
		} catch (error) {
			logger.error('Error in sendFCMNotification:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
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

			const users = await User.find({
				_id: { $in: uniqueUserIds.map(toObjectId) },
				organizationId: toObjectId(input.organizationId),
			}).select('_id name notificationPreferences');

			const title = 'Trip Started';
			const message = `Bus ${input.busNumberPlate} has started its trip. Track it live!`;
			const voiceMessage = `Bus ${input.busNumberPlate} has started its trip.`;
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
							logger.info(`[Notification] Sending TRIP_STARTED FCM to token: ${token.substring(0, 15)}...`);
							await sendPushNotification({
								fcmToken: token,
								title,
								body: message,
								data: {
									type: NOTIFICATION_TYPES.TRIP_STARTED,
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									tripId: input.tripId,
									voiceMessage,
								},
							});
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

			const users = await User.find({
				_id: { $in: uniqueUserIds.map(toObjectId) },
				organizationId: toObjectId(input.organizationId),
			}).select('_id name notificationPreferences');

			const title = 'Trip Completed';
			const message = `Bus ${input.busNumberPlate} has completed its trip.`;
			const voiceMessage = `Bus ${input.busNumberPlate} has completed its trip.`;
			let notifiedCount = 0;

			for (const user of users) {
				try {
					const userId = user._id.toString();

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
							logger.info(`[Notification] Sending TRIP_COMPLETED FCM to token: ${token.substring(0, 15)}...`);
							await sendPushNotification({
								fcmToken: token,
								title,
								body: message,
								data: {
									type: NOTIFICATION_TYPES.TRIP_COMPLETED,
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									tripId: input.tripId,
									voiceMessage,
								},
							});
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

			const users = await User.find({
				_id: { $in: uniqueUserIds.map(toObjectId) },
				organizationId: toObjectId(input.organizationId),
			}).select('_id name notificationPreferences');

			const title = 'Bus Delayed';
			const message = `Bus ${input.busNumberPlate} is delayed by ~${input.delayMinutes} minutes.${input.reason ? ' ' + input.reason : ''}`;
			const voiceMessage = `Bus ${input.busNumberPlate} is delayed by ${input.delayMinutes} minutes.`;
			let notifiedCount = 0;

			for (const user of users) {
				try {
					const userId = user._id.toString();
					const prefs = user.notificationPreferences;
					if (prefs && prefs.delayAlertsEnabled === false) {
						logger.info(`[Notification] User ${user.name} (ID: ${userId}) has disabled delay alerts. Skipping.`);
						continue;
					}

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
							logger.info(`[Notification] Sending DELAY_ALERT FCM to token: ${token.substring(0, 15)}...`);
							await sendPushNotification({
								fcmToken: token,
								title,
								body: message,
								data: {
									type: NOTIFICATION_TYPES.DELAY_ALERT,
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									delayMinutes: String(input.delayMinutes),
									voiceMessage,
								},
							});
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


