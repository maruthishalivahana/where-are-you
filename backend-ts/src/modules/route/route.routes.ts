import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ROLES } from '../../constants/roles';
import { routeController } from './route.controller';
import { z } from 'zod';

export const routeRouter = Router();

const createRouteSchema = z.object({
    body: z.object({
        name: z.string().min(1, 'name is required'),
        startLat: z.number({ error: 'startLat must be a number' }),
        startLng: z.number({ error: 'startLng must be a number' }),
        endLat: z.number({ error: 'endLat must be a number' }),
        endLng: z.number({ error: 'endLng must be a number' }),
    }),
});

const updateRouteSchema = z.object({
    body: z
        .object({
            name: z.string().min(1, 'name must not be empty').optional(),
            startLat: z.number({ error: 'startLat must be a number' }).optional(),
            startLng: z.number({ error: 'startLng must be a number' }).optional(),
            endLat: z.number({ error: 'endLat must be a number' }).optional(),
            endLng: z.number({ error: 'endLng must be a number' }).optional(),
            isActive: z.boolean().optional(),
        })
        .refine((value) => Object.keys(value).length > 0, {
            message: 'At least one field is required',
        }),
});

routeRouter.use(requireAuth, requireRole(ROLES.ADMIN));

routeRouter.post('/', validate(createRouteSchema), routeController.createRoute);
routeRouter.post('/:routeId/recalculate-polyline', routeController.recalculateRoutePolyline);
routeRouter.get('/', routeController.getRoutes);
routeRouter.get('/:routeId', routeController.getRouteById);
routeRouter.put('/:routeId', validate(updateRouteSchema), routeController.updateRoute);
routeRouter.delete('/:routeId', routeController.deleteRoute);
