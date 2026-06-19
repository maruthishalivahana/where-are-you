import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { emailDebugController } from './email.debug.controller';

export const emailDebugRouter = Router();

// Only authenticated Admins are allowed to trigger email debug actions
emailDebugRouter.use(requireAuth, requireRole(ROLES.ADMIN));

emailDebugRouter.post('/test-send', emailDebugController.testSend);
emailDebugRouter.get('/logs', emailDebugController.getLogs);
emailDebugRouter.get('/stats', emailDebugController.getStats);
emailDebugRouter.post('/trigger-scheduler', emailDebugController.triggerScheduler);
