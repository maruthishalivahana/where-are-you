import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { routeController } from './route.controller';
import { DeviceToken } from '../notification/deviceToken.model';

export const routeDebugRouter = Router();

routeDebugRouter.get('/device-tokens', requireAuth, async (req, res) => {
	try {
		const targetUserId = (req.user?.role === 'admin' && req.query.userId)
			? String(req.query.userId)
			: req.user?.sub;

		if (!targetUserId) {
			return res.status(400).json({ success: false, message: 'Missing target user ID' });
		}

		const tokens = await DeviceToken.find({ userId: targetUserId } as any);

		res.status(200).json({
			userId: targetUserId,
			tokens: tokens.map(t => ({
				deviceToken: t.deviceToken,
				deviceType: t.deviceType,
				isActive: t.isActive,
				lastSeen: t.lastUsedAt || t.createdAt,
			}))
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching device tokens',
			error: error instanceof Error ? error.message : 'Unknown error'
		});
	}
});

routeDebugRouter.use(requireAuth, requireRole(ROLES.ADMIN));
routeDebugRouter.get('/routes/:id', routeController.getRouteDebugById);
