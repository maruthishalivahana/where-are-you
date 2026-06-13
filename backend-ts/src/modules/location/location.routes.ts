import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';
import { locationController } from './location.controller';
import { searchLocationSchema } from './location.validation';

export const locationRouter = Router();

locationRouter.get(
    '/search',
    requireAuth,
    requireRole(ROLES.ADMIN),
    validate(searchLocationSchema),
    locationController.searchLocations
);
