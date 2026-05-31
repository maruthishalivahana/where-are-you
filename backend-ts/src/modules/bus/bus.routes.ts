import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { requireActivePlan } from '../../middleware/plan.middleware';
import { ROLES } from '../../constants/roles';
import { busController } from './bus.controller';

export const busRouter = Router();

// Admin routes
busRouter.use(requireAuth, requireRole(ROLES.ADMIN), requireActivePlan);

busRouter.post('/', busController.createBus);
busRouter.get('/', busController.getBuses);
busRouter.get('/:busId', busController.getBusById);
busRouter.put('/:busId/driver', busController.updateBusDriver);
busRouter.put('/:busId/route', busController.updateBusRoute);
busRouter.delete('/:busId', busController.deleteBus);
