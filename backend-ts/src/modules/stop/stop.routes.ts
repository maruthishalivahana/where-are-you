import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { requireActivePlan } from '../../middleware/plan.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ROLES } from '../../constants/roles';
import { stopController } from './stop.controller';
import { z } from 'zod';

export const stopRouter = Router();

const createStopSchema = z.object({
    body: z.object({
        name: z.string().min(1, 'name is required'),
        latitude: z.coerce.number({ error: 'latitude must be a number' }),
        longitude: z.coerce.number({ error: 'longitude must be a number' }),
        sequenceOrder: z.coerce.number({ error: 'sequenceOrder must be a number' }).int('sequenceOrder must be an integer').min(1, 'sequenceOrder must be at least 1'),
        radiusMeters: z.coerce.number().positive('radiusMeters must be positive').optional(),
    }),
});

const updateStopSchema = z.object({
    body: z
        .object({
            name: z.string().min(1).optional(),
            latitude: z.coerce.number().optional(),
            longitude: z.coerce.number().optional(),
            sequenceOrder: z.coerce.number().int().min(1).optional(),
            radiusMeters: z.coerce.number().positive().optional(),
        })
        .refine((value) => Object.keys(value).length > 0, {
            message: 'At least one field is required',
        }),
});

stopRouter.use(requireAuth, requireRole(ROLES.ADMIN), requireActivePlan);

// Routes under /api/admin/routes/:routeId/stops
stopRouter.post('/routes/:routeId/stops', validate(createStopSchema), stopController.createStop);
stopRouter.get('/routes/:routeId/stops', stopController.getStopsByRoute);

// Routes under /api/admin/stops/:id
stopRouter.put('/stops/:id', validate(updateStopSchema), stopController.updateStop);
stopRouter.delete('/stops/:id', stopController.deleteStop);
