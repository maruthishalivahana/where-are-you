import mongoose from 'mongoose';
import { NOTIFICATION_TYPES } from '../../constants/notificationTypes';
import { calculateDistanceMeters } from '../../utils/calculateDistance';
import { BusSubscription } from '../busSubscription/busSubscription.model';
import { Stop } from '../stop/stop.model';
import { Notification } from './notification.model';
import { User } from '../user/user.model';
import { sendPushNotification } from '../../utils/sendPushNotification';
import { messaging } from '../../config/fcm.config';
import { DeviceToken } from './deviceToken.model';
import { logger } from '../../utils/logger';

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);
const NEAR_STOP_COOLDOWN_MS = 5 * 60 * 1000;
const ARRIVED_THRESHOLD_M = 50;
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
		const subscriptions = await BusSubscription.find({
			organizationId: toObjectId(input.organizationId),
			busId: toObjectId(input.busId),
			isActive: true,
		}).populate('stopId', 'name latitude longitude radiusMeters');

		if (subscriptions.length === 0) {
			return;
		}

		for (const subscription of subscriptions) {
			let updatedSubscription = false;
			const deviceTokens = await notificationService.getUserDeviceTokens(subscription.userId.toString());

			if (input.isBusStartedEvent && subscription.notifyOnBusStart) {
				const title = 'Bus started';
				const message = `Bus ${input.busNumberPlate} has started`;

				await Notification.create({
					organizationId: subscription.organizationId,
					userId: subscription.userId,
					busId: subscription.busId,
					type: NOTIFICATION_TYPES.BUS_STARTED,
					title,
					message,
					payload: {
						busId: input.busId,
						numberPlate: input.busNumberPlate,
						latitude: input.latitude,
						longitude: input.longitude,
					},
				});

				for (const token of deviceTokens) {
					await sendPushNotification({
						fcmToken: token,
						title,
						body: message,
						data: {
							type: NOTIFICATION_TYPES.BUS_STARTED,
							busId: input.busId,
							numberPlate: input.busNumberPlate,
						},
					});
				}

				subscription.lastStartNotifiedAt = new Date();
				updatedSubscription = true;
			}

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

				if (targetLat !== null && targetLng !== null) {
					const distance = calculateDistanceMeters(
						input.latitude,
						input.longitude,
						targetLat,
						targetLng
					);

					const radius =
						subscription.nearRadiusMeters ||
						(typeof stop?.radiusMeters === 'number' ? stop.radiusMeters : 150);

					const canNotifyNearStop =
						!subscription.lastNearStopNotifiedAt ||
						Date.now() - new Date(subscription.lastNearStopNotifiedAt).getTime() >=
							NEAR_STOP_COOLDOWN_MS;

					const stopName = stop?.name || 'your location';

					if (distance <= radius && canNotifyNearStop) {
						const title = 'Bus is nearby';
						const message = `Bus ${input.busNumberPlate} is near ${stopName}`;

						await Notification.create({
							organizationId: subscription.organizationId,
							userId: subscription.userId,
							busId: subscription.busId,
							stopId: stop?._id || null,
							type: NOTIFICATION_TYPES.BUS_NEAR_STOP,
							title,
							message,
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

						for (const token of deviceTokens) {
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
								},
							});
						}

						subscription.lastNearStopNotifiedAt = new Date();
						updatedSubscription = true;
					}

					// BUS_ARRIVED check (≤50m threshold)
					if (distance <= ARRIVED_THRESHOLD_M) {
						const canNotifyArrived =
							!(subscription as any).lastArrivedNotifiedAt ||
							Date.now() - new Date((subscription as any).lastArrivedNotifiedAt).getTime() >=
								ARRIVED_COOLDOWN_MS;

						if (canNotifyArrived) {
							const arrivedTitle = 'Bus Arrived';
							const arrivedMessage = `Bus ${input.busNumberPlate} has arrived at ${stopName}`;

							await Notification.create({
								organizationId: subscription.organizationId,
								userId: subscription.userId,
								busId: subscription.busId,
								stopId: stop?._id || null,
								type: NOTIFICATION_TYPES.BUS_ARRIVED,
								title: arrivedTitle,
								message: arrivedMessage,
								payload: {
									busId: input.busId,
									numberPlate: input.busNumberPlate,
									latitude: input.latitude,
									longitude: input.longitude,
									stopName,
								},
							});

							for (const token of deviceTokens) {
								await sendPushNotification({
									fcmToken: token,
									title: arrivedTitle,
									body: arrivedMessage,
									data: {
										type: NOTIFICATION_TYPES.BUS_ARRIVED,
										busId: input.busId,
										numberPlate: input.busNumberPlate,
										stopName,
									},
								});
							}

							(subscription as any).lastArrivedNotifiedAt = new Date();
							updatedSubscription = true;
						}
					}
				}
			}

			if (updatedSubscription) {
				await subscription.save();
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

			// FCM message structure
			const fcmMessage: any = {
				notification: {
					title: input.title,
					body: input.body,
				},
				data: {
					notificationType: input.type,
					tripId: input.tripId,
					busId: input.busId,
					voiceMessage: input.voiceMessage,
					isSticky: String(input.isSticky || false),
					noSound: String(input.noSound || false),
				},
			};

			// Add Android-specific configuration for sticky/silent notifications
			if (input.noSound) {
				fcmMessage.android = {
					priority: 'high',
					notification: {
						sound: null,
						channelId: 'driver_channel',
						tag: input.tripId ? `trip_${input.tripId}` : 'driver_notification',
					},
				};
			}

			let successCount = 0;
			let failureCount = 0;

			for (const token of deviceTokens) {
				try {
					const messageId = await messaging.send({
						...fcmMessage,
						token,
					});

					successCount++;
					logger.info(`FCM sent to device: ${messageId}`);
				} catch (error) {
					failureCount++;
					logger.error(`FCM send failed for token ${token}:`, error);

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
	 * Handle trip started — notify all users with stops in the organization
	 */
	handleTripStarted: async (input: {
		organizationId: string;
		busId: string;
		busNumberPlate: string;
		tripId: string;
		routeId: string;
	}) => {
		try {
			logger.info(`[Notification] handleTripStarted bus=${input.busNumberPlate} trip=${input.tripId}`);

			// Find all users with a stopId in this organization
			const users = await User.find({
				organizationId: toObjectId(input.organizationId),
				stopId: { $exists: true, $ne: null },
			}).select('_id notificationPreferences');

			if (users.length === 0) {
				logger.info('[Notification] No users with stops found for trip started notification');
				return;
			}

			const title = 'Trip Started';
			const message = `Bus ${input.busNumberPlate} has started its trip. Track it live!`;

			for (const user of users) {
				const prefs = user.notificationPreferences;
				if (prefs && prefs.tripStartedEnabled === false) {
					continue;
				}

				await Notification.create({
					organizationId: toObjectId(input.organizationId),
					userId: user._id,
					busId: toObjectId(input.busId),
					tripId: toObjectId(input.tripId),
					type: NOTIFICATION_TYPES.TRIP_STARTED,
					title,
					message,
					payload: {
						busId: input.busId,
						numberPlate: input.busNumberPlate,
						tripId: input.tripId,
						routeId: input.routeId,
					},
				});

				const deviceTokens = await notificationService.getUserDeviceTokens(user._id.toString());
				for (const token of deviceTokens) {
					await sendPushNotification({
						fcmToken: token,
						title,
						body: message,
						data: {
							type: NOTIFICATION_TYPES.TRIP_STARTED,
							busId: input.busId,
							numberPlate: input.busNumberPlate,
							tripId: input.tripId,
						},
					});
				}
			}

			logger.info(`[Notification] Trip started notifications sent to ${users.length} users`);
		} catch (error) {
			logger.error('[Notification] handleTripStarted error:', error);
		}
	},

	/**
	 * Handle trip completed — notify subscribed users
	 */
	handleTripCompleted: async (input: {
		organizationId: string;
		busId: string;
		busNumberPlate: string;
		tripId: string;
		routeId: string;
	}) => {
		try {
			logger.info(`[Notification] handleTripCompleted bus=${input.busNumberPlate} trip=${input.tripId}`);

			// Find subscribed users for this bus
			const subscriptions = await BusSubscription.find({
				organizationId: toObjectId(input.organizationId),
				busId: toObjectId(input.busId),
				isActive: true,
			});

			const title = 'Trip Completed';
			const message = `Bus ${input.busNumberPlate} has completed its trip.`;

			for (const sub of subscriptions) {
				const user = await User.findById(sub.userId).select('_id');
				if (!user) continue;

				await Notification.create({
					organizationId: toObjectId(input.organizationId),
					userId: user._id,
					busId: toObjectId(input.busId),
					tripId: toObjectId(input.tripId),
					type: NOTIFICATION_TYPES.TRIP_STARTED,
					title,
					message,
					payload: {
						busId: input.busId,
						numberPlate: input.busNumberPlate,
						tripId: input.tripId,
						routeId: input.routeId,
					},
				});

				const deviceTokens = await notificationService.getUserDeviceTokens(user._id.toString());
				for (const token of deviceTokens) {
					await sendPushNotification({
						fcmToken: token,
						title,
						body: message,
						data: {
							type: NOTIFICATION_TYPES.TRIP_STARTED,
							busId: input.busId,
							numberPlate: input.busNumberPlate,
							tripId: input.tripId,
						},
					});
				}
			}

			logger.info(`[Notification] Trip completed notifications sent to ${subscriptions.length} subscribers`);
		} catch (error) {
			logger.error('[Notification] handleTripCompleted error:', error);
		}
	},

	/**
	 * Handle delay alert — notify all users with stops in the organization
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
			logger.info(`[Notification] handleDelayAlert bus=${input.busNumberPlate} delay=${input.delayMinutes}min`);

			const users = await User.find({
				organizationId: toObjectId(input.organizationId),
				stopId: { $exists: true, $ne: null },
			}).select('_id notificationPreferences');

			const title = 'Bus Delayed';
			const message = `Bus ${input.busNumberPlate} is delayed by ~${input.delayMinutes} minutes.${input.reason ? ' ' + input.reason : ''}`;

			for (const user of users) {
				const prefs = user.notificationPreferences;
				if (prefs && prefs.delayAlertsEnabled === false) {
					continue;
				}

				await Notification.create({
					organizationId: toObjectId(input.organizationId),
					userId: user._id,
					busId: toObjectId(input.busId),
					tripId: toObjectId(input.tripId),
					type: NOTIFICATION_TYPES.DELAY_ALERT,
					title,
					message,
					payload: {
						busId: input.busId,
						numberPlate: input.busNumberPlate,
						tripId: input.tripId,
						delayMinutes: String(input.delayMinutes),
					},
				});

				const deviceTokens = await notificationService.getUserDeviceTokens(user._id.toString());
				for (const token of deviceTokens) {
					await sendPushNotification({
						fcmToken: token,
						title,
						body: message,
						data: {
							type: NOTIFICATION_TYPES.DELAY_ALERT,
							busId: input.busId,
							numberPlate: input.busNumberPlate,
							delayMinutes: String(input.delayMinutes),
						},
					});
				}
			}

			logger.info(`[Notification] Delay alert sent to ${users.length} users`);
		} catch (error) {
			logger.error('[Notification] handleDelayAlert error:', error);
		}
	},
};


