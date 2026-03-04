import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { driverController } from './driver.controller';

export const driverRouter = Router();

// Admin routes
driverRouter.get('/admin/all', requireAuth, requireRole(ROLES.ADMIN), driverController.listDrivers);

// Driver routes (driver-only)
driverRouter.get('/me', requireAuth, requireRole(ROLES.DRIVER), driverController.getMyDetails);
driverRouter.get('/my-bus', requireAuth, requireRole(ROLES.DRIVER), driverController.getMyBus);
driverRouter.get('/my-route', requireAuth, requireRole(ROLES.DRIVER), driverController.getMyRoute);
driverRouter.post('/tracking/start', requireAuth, requireRole(ROLES.DRIVER), driverController.startTracking);
driverRouter.post('/tracking/stop', requireAuth, requireRole(ROLES.DRIVER), driverController.stopTracking);
