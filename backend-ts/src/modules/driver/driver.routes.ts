import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { requireActivePlan } from '../../middleware/plan.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ROLES } from '../../constants/roles';
import { driverController } from './driver.controller';
import { z } from 'zod';

export const driverRouter = Router();

const updateDriverSchema = z.object({
	body: z
		.object({
			name: z.string().min(2, 'name must be at least 2 characters').optional(),
			memberId: z.string().min(1, 'memberId cannot be empty').optional(),
			email: z.string().email('invalid email address').optional(),
			phone: z.string().min(7, 'phone must be at least 7 characters').max(20, 'phone must be at most 20 characters').optional(),
			password: z.string().min(8, 'password must be at least 8 characters').optional(),
		})
		.refine((value) => Object.keys(value).length > 0, {
			message: 'At least one field is required',
		}),
});

// Admin routes
driverRouter.use('/admin', requireAuth, requireRole(ROLES.ADMIN), requireActivePlan);
driverRouter.get('/admin/all', driverController.listDrivers);
driverRouter.put('/admin/:id', validate(updateDriverSchema), driverController.updateDriver);
driverRouter.delete('/admin/:id', driverController.deleteDriver);

// Driver routes (driver-only)
driverRouter.get('/me', requireAuth, requireRole(ROLES.DRIVER), driverController.getMyDetails);
driverRouter.get('/my-bus', requireAuth, requireRole(ROLES.DRIVER), driverController.getMyBus);
driverRouter.get('/my-route', requireAuth, requireRole(ROLES.DRIVER), driverController.getMyRoute);
driverRouter.post('/tracking/start', requireAuth, requireRole(ROLES.DRIVER), driverController.startTracking);
driverRouter.post('/tracking/stop', requireAuth, requireRole(ROLES.DRIVER), driverController.stopTracking);
