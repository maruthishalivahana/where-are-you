import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ROLES } from '../../constants/roles';
import { userAppController } from './user.app.controller';

export const userAppRouter = Router();

const subscribeSchema = z.object({
    body: z.object({
        busId: z.string().min(1, 'busId is required'),
        stopId: z.string().min(1, 'stopId is required').optional(),
        alertBeforeMinutes: z.number().int().min(1).max(60).optional(),
    }),
});

const fcmTokenSchema = z.object({
    body: z.object({
        fcmToken: z
            .string()
            .min(10, 'fcmToken is too short')
            .max(4096, 'fcmToken is too long'),
    }),
});

userAppRouter.use(requireAuth, requireRole(ROLES.USER));

// PHASE 4: New endpoint for automatic route-based tracking
userAppRouter.get('/tracking/active-trip', userAppController.getTrackingData);

userAppRouter.get('/buses/search', userAppController.searchBuses);
userAppRouter.get('/buses/:busId/live', userAppController.getLiveBus);

userAppRouter.post('/subscriptions', validate(subscribeSchema), userAppController.subscribeBus);
userAppRouter.get('/subscriptions', userAppController.getMySubscriptions);
userAppRouter.delete('/subscriptions/:subscriptionId', userAppController.unsubscribeBus);

userAppRouter.patch('/profile/fcm-token', validate(fcmTokenSchema), userAppController.updateMyFcmToken);
userAppRouter.put('/profile/fcm-token', validate(fcmTokenSchema), userAppController.updateMyFcmToken);
userAppRouter.put('/fcm-token', validate(fcmTokenSchema), userAppController.updateMyFcmToken);
userAppRouter.get('/profile', userAppController.getProfile);

userAppRouter.get('/routes', userAppController.getAvailableRoutes);
userAppRouter.get('/routes/:routeId/stops', userAppController.getRouteStops);
userAppRouter.post('/profile/assigned-stop', userAppController.assignStop);
userAppRouter.get('/profile/assigned-stop', userAppController.getAssignedStop);
