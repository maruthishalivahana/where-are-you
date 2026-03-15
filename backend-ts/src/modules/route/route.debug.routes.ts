import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { routeController } from './route.controller';

export const routeDebugRouter = Router();

routeDebugRouter.use(requireAuth, requireRole(ROLES.ADMIN));
routeDebugRouter.get('/routes/:id', routeController.getRouteDebugById);
