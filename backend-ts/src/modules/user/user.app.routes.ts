import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { userAppController } from './user.app.controller';

export const userAppRouter = Router();

userAppRouter.use(requireAuth, requireRole(ROLES.USER));

// PHASE 4: New endpoint for automatic route-based tracking
userAppRouter.get('/tracking/active-trip', userAppController.getTrackingData);

userAppRouter.get('/buses/search', userAppController.searchBuses);
userAppRouter.get('/buses/:busId/live', userAppController.getLiveBus);

userAppRouter.post('/subscriptions', userAppController.subscribeBus);
userAppRouter.get('/subscriptions', userAppController.getMySubscriptions);
userAppRouter.delete('/subscriptions/:subscriptionId', userAppController.unsubscribeBus);

userAppRouter.patch('/profile/fcm-token', userAppController.updateMyFcmToken);
userAppRouter.put('/profile/fcm-token', userAppController.updateMyFcmToken);
userAppRouter.put('/fcm-token', userAppController.updateMyFcmToken);
userAppRouter.get('/profile', userAppController.getProfile);

userAppRouter.get('/routes', userAppController.getAvailableRoutes);
userAppRouter.get('/routes/:routeId/stops', userAppController.getRouteStops);
userAppRouter.post('/profile/assigned-stop', userAppController.assignStop);
userAppRouter.get('/profile/assigned-stop', userAppController.getAssignedStop);
