import { eventBus } from '../../events/eventBus';
import { notificationService } from './notification.service';
import { logger } from '../../utils/logger';
import { calculateDistanceMeters } from '../../utils/calculateDistance';
import mongoose from 'mongoose';
import { User } from '../user/user.model';
import { Stop } from '../stop/stop.model';
import { Bus } from '../bus/bus.model';
import { Trip } from '../trip/trip.model';

const NOTIFICATION_DEDUP = new Map<string, boolean>();
const NEAR_STOP_THRESHOLD_M = 500; // Default 500 meters
const ARRIVED_THRESHOLD_M = 50; // Default 50 meters

/**
 * Generate unique notification key for deduplication
 */
const getNotificationKey = (type: string, tripId: string, busId: string, userId: string): string => {
	return `${type}_${tripId}_${busId}_${userId}`;
};

/**
 * Check and mark notification as sent (deduplication)
 */
const markNotificationSent = (key: string): boolean => {
	if (NOTIFICATION_DEDUP.has(key)) {
		return false; // Already sent
	}
	NOTIFICATION_DEDUP.set(key, true);
	return true; // First time
};

/**
 * Estimate ETA in seconds based on distance and speed
 */
const estimateETA = (distanceMeters: number, speedKmh: number = 30): number => {
	if (speedKmh <= 0) return 0;
	const distanceKm = distanceMeters / 1000;
	const hours = distanceKm / speedKmh;
	return Math.ceil(hours * 3600);
};

/**
 * Calculate if notification should be sent based on alert preference
 */
const shouldSendAlertBeforeArrival = (
	distanceMeters: number,
	etaSeconds: number,
	alertPreferenceSeconds: number
): boolean => {
	// Send if ETA is within the preference window
	return etaSeconds <= alertPreferenceSeconds && etaSeconds > 0;
};

export const initializeNotificationListeners = () => {
	/**
	 * TRIP_STARTED event
	 * Triggers when trip status changes Pending → Active
	 */
	eventBus.on('TRIP_STARTED', async (data: any) => {
		try {
			const { tripId, busId, organizationId, busNumberPlate, routeId } = data;

			logger.info(`TRIP_STARTED event: tripId=${tripId}, busId=${busId}`);

			await notificationService.handleTripStarted({
				organizationId: String(organizationId),
				busId: String(busId),
				busNumberPlate: busNumberPlate || 'Unknown',
				tripId: String(tripId),
				routeId: String(routeId || ''),
			});
		} catch (error) {
			logger.error('Error in TRIP_STARTED listener:', error);
		}
	});

	/**
	 * BUS_LOCATION_UPDATE event
	 * Triggers for BUS_NEAR_STOP and BUS_ARRIVED
	 */
	eventBus.on('BUS_LOCATION_UPDATE', async (data: any) => {
		try {
			const { busId, tripId, organizationId, latitude, longitude } = data;

			logger.info(`BUS_LOCATION_UPDATE: busId=${busId}, lat=${latitude}, lng=${longitude}`);

			// Get all students assigned to stops on this route
			const students = await User.find({
				organizationId,
				stopId: { $exists: true, $ne: null },
			})
				.select('_id stopId')
				.populate('stopId', 'latitude longitude name');

			if (students.length === 0) {
				logger.warn(`No students found for route in org: ${organizationId}`);
				return;
			}

			// Process each student
			for (const student of students) {
				const stop = (student.stopId as any);
				if (!stop || !stop.latitude || !stop.longitude) {
					logger.warn(`Invalid stop data for student: ${student._id}`);
					continue;
				}

				// Calculate distance from bus to student's assigned stop
				const distanceM = calculateDistanceMeters(
					latitude,
					longitude,
					stop.latitude,
					stop.longitude
				);

				// Check BUS_NEAR_STOP (500m threshold)
				if (distanceM <= NEAR_STOP_THRESHOLD_M) {
					const notifKey = getNotificationKey('BUS_NEAR_STOP', tripId, busId, student._id.toString());

					if (markNotificationSent(notifKey)) {
						const prefs = await notificationService.getUserPreferences(student._id.toString());
						if (prefs.busNearStopEnabled) {
							const payload = {
								organizationId: organizationId,
								userId: student._id.toString(),
								busId,
								tripId,
								type: 'BUS_NEAR_STOP',
								title: 'Bus Near Your Stop',
								body: `Your bus is approaching ${stop.name}.`,
								voiceMessage: `Your bus is approaching ${stop.name}. Please be ready.`,
							};

							const result = await notificationService.sendFCMNotification(payload);
							logger.info(`BUS_NEAR_STOP sent to ${student._id}: ${result.success}`);
						}
					}
				}

				// Check BUS_ARRIVED (50m threshold)
				if (distanceM <= ARRIVED_THRESHOLD_M) {
					const notifKey = getNotificationKey('BUS_ARRIVED', tripId, busId, student._id.toString());

					if (markNotificationSent(notifKey)) {
						const prefs = await notificationService.getUserPreferences(student._id.toString());
						if (prefs.busArrivedEnabled) {
							const payload = {
								organizationId: organizationId,
								userId: student._id.toString(),
								busId,
								tripId,
								type: 'BUS_ARRIVED',
								title: 'Bus Arrived',
								body: `Your bus has arrived at ${stop.name}.`,
								voiceMessage: `Your bus has arrived at ${stop.name}.`,
							};

							const result = await notificationService.sendFCMNotification(payload);
							logger.info(`BUS_ARRIVED sent to ${student._id}: ${result.success}`);
						}
					}
				}
			}
		} catch (error) {
			logger.error('Error in BUS_LOCATION_UPDATE listener:', error);
		}
	});

	/**
	 * DELAY_ALERT event
	 * Triggers when bus deviates from schedule
	 */
	eventBus.on('DELAY_ALERT', async (data: any) => {
		try {
			const { tripId, busId, organizationId, delayMinutes, reason, busNumberPlate, routeId } = data;

			logger.info(`DELAY_ALERT event: busId=${busId}, delayMinutes=${delayMinutes}`);

			await notificationService.handleDelayAlert({
				organizationId: String(organizationId),
				busId: String(busId),
				busNumberPlate: busNumberPlate || 'Unknown',
				tripId: String(tripId),
				routeId: String(routeId || ''),
				delayMinutes: Number(delayMinutes) || 0,
				reason: reason || undefined,
			});
		} catch (error) {
			logger.error('Error in DELAY_ALERT listener:', error);
		}
	});

	/**
	 * TRIP_COMPLETED event
	 */
	eventBus.on('TRIP_COMPLETED', async (data: any) => {
		try {
			const { tripId, busId, organizationId, busNumberPlate, routeId } = data;

			logger.info(`TRIP_COMPLETED event: tripId=${tripId}, busId=${busId}`);

			await notificationService.handleTripCompleted({
				organizationId: String(organizationId),
				busId: String(busId),
				busNumberPlate: busNumberPlate || 'Unknown',
				tripId: String(tripId),
				routeId: String(routeId || ''),
			});
		} catch (error) {
			logger.error('Error in TRIP_COMPLETED listener:', error);
		}
	});

	/**
	 * DRIVER_STICKY_NOTIFICATION event
	 * Sticky notification for drivers (no sound, stays in notification bar)
	 * Used when app runs in background
	 */
	eventBus.on('DRIVER_STICKY_NOTIFICATION', async (data: any) => {
		try {
			const { driverId, title, body, voiceMessage, tripId, organizationId } = data;

			logger.info(`DRIVER_STICKY_NOTIFICATION: driverId=${driverId}, tripId=${tripId}`);

			const payload = {
				organizationId: organizationId,
				userId: driverId,
				busId: data.busId || '',
				tripId: tripId || '',
				type: 'DRIVER_STICKY',
				title: title,
				body: body,
				voiceMessage: voiceMessage || '',
				isSticky: true,
				noSound: true,
			};

			const result = await notificationService.sendFCMNotification(payload);
			logger.info(`DRIVER_STICKY_NOTIFICATION sent to ${driverId}: ${result.success}`);
		} catch (error) {
			logger.error('Error in DRIVER_STICKY_NOTIFICATION listener:', error);
		}
	});

	logger.info('Notification event listeners initialized');
};
