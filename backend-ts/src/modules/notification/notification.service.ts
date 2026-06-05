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
			const user = await User.findById(subscription.userId).select('_id fcmToken');
			const fcmToken = user?.fcmToken ? String(user.fcmToken).trim() : '';

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

				if (fcmToken) {
					await sendPushNotification({
						fcmToken,
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

					if (distance <= radius && canNotifyNearStop) {
						const stopName = stop?.name || 'your location';
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

						if (fcmToken) {
							await sendPushNotification({
								fcmToken,
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
			const existing = await DeviceToken.findOne({ deviceToken });

			if (existing) {
				if (existing.userId.toString() !== userId) {
					(existing.userId as any) = toObjectId(userId);
					existing.lastUsedAt = new Date();
					await existing.save();
				}
				return true;
			}

			await DeviceToken.create({
				userId: toObjectId(userId) as any,
				deviceToken,
				deviceType,
				isActive: true,
				lastUsedAt: new Date(),
			});

			logger.info(`Device token registered: ${userId}`);
			return true;
		} catch (error) {
			logger.error('Error registering device token:', error);
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
};


