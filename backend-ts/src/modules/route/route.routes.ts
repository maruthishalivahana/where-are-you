import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { requireActivePlan } from '../../middleware/plan.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ROLES } from '../../constants/roles';
import { routeController } from './route.controller';
import { z } from 'zod';

export const routeRouter = Router();

const createRouteSchema = z.object({
    body: z.object({
        name: z.string().min(1, 'name is required'),
        startName: z.string().min(1, 'startName is required').optional(),
        endName: z.string().min(1, 'endName is required').optional(),
        startLat: z.coerce.number({ error: 'startLat must be a number' }),
        startLng: z.coerce.number({ error: 'startLng must be a number' }),
        endLat: z.coerce.number({ error: 'endLat must be a number' }),
        endLng: z.coerce.number({ error: 'endLng must be a number' }),
    }),
});

const updateRouteSchema = z.object({
    body: z
        .object({
            name: z.string().min(1, 'name must not be empty').optional(),
            startName: z.string().min(1, 'startName must not be empty').optional(),
            endName: z.string().min(1, 'endName must not be empty').optional(),
            startLat: z.coerce.number({ error: 'startLat must be a number' }).optional(),
            startLng: z.coerce.number({ error: 'startLng must be a number' }).optional(),
            endLat: z.coerce.number({ error: 'endLat must be a number' }).optional(),
            endLng: z.coerce.number({ error: 'endLng must be a number' }).optional(),
            isActive: z.boolean().optional(),
        })
        .refine((value) => Object.keys(value).length > 0, {
            message: 'At least one field is required',
        }),
});

routeRouter.use(requireAuth, requireRole(ROLES.ADMIN), requireActivePlan);

routeRouter.post('/', validate(createRouteSchema), routeController.createRoute);
routeRouter.post('/:routeId/recalculate-polyline', routeController.recalculateRoutePolyline);
routeRouter.get('/', routeController.getRoutes);
routeRouter.get('/options', routeController.getRouteOptions);
routeRouter.get('/:routeId', routeController.getRouteById);
routeRouter.put('/:routeId', validate(updateRouteSchema), routeController.updateRoute);
routeRouter.delete('/:routeId', routeController.deleteRoute);
