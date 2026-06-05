import { Router } from 'express';
import { notificationService } from './notification.service';
import { requireAuth } from '../../middleware/auth.middleware';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * Register device token for FCM
 * POST /api/notifications/register-device
 */
router.post('/register-device', requireAuth, async (req, res) => {
	try {
		const { deviceToken, deviceType } = req.body;
		const userId = req.user?.sub;

		if (!userId || !deviceToken || !deviceType) {
			return res.status(400).json({
				success: false,
				message: 'Missing required fields: userId, deviceToken, deviceType',
			});
		}

		if (!['ios', 'android', 'web'].includes(deviceType)) {
			return res.status(400).json({
				success: false,
				message: 'Invalid deviceType. Must be: ios, android, or web',
			});
		}

		const result = await notificationService.registerDeviceToken(userId, deviceToken, deviceType);

		if (result) {
			logger.info(`Device registered for user: ${userId}`);
			return res.status(200).json({
				success: true,
				message: 'Device token registered successfully',
			});
		} else {
			return res.status(500).json({
				success: false,
				message: 'Failed to register device token',
			});
		}
	} catch (error) {
		logger.error('Error in register-device:', error);
		res.status(500).json({
			success: false,
			message: 'Internal server error',
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

/**
 * Get user notification preferences
 * GET /api/notifications/preferences
 */
router.get('/preferences', requireAuth, async (req, res) => {
	try {
		const userId = req.user?.sub;

		if (!userId) {
			return res.status(401).json({
				success: false,
				message: 'Unauthorized',
			});
		}

		const preferences = await notificationService.getUserPreferences(userId);

		res.status(200).json({
			success: true,
			data: preferences,
		});
	} catch (error) {
		logger.error('Error in get-preferences:', error);
		res.status(500).json({
			success: false,
			message: 'Internal server error',
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

export const deviceTokenRoutes = router;
