import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { simulationController } from './simulation.controller';

export const simulationRouter = Router();

// Admin-only endpoint for testing notifications via Postman
simulationRouter.use(requireAuth, requireRole(ROLES.ADMIN));

simulationRouter.post('/simulate', simulationController.simulate);
simulationRouter.post('/test-push', simulationController.testPush);
