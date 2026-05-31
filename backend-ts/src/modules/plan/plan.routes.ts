import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { planController } from './plan.controller';

export const planRouter = Router();

planRouter.use(requireAuth, requireRole(ROLES.ADMIN));

planRouter.get('/', planController.listPlans);
planRouter.get('/current', planController.getCurrentPlan);
planRouter.get('/summary', planController.getPlanSummary);
planRouter.get('/capacity', planController.getCapacityInfo);
planRouter.get('/history', planController.getPaymentHistory);
planRouter.post('/activate', planController.activatePlan);
