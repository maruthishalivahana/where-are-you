import { Router } from 'express';
import { trackingController } from './tracking.controller';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/role.middleware';
import { ROLES } from '../../constants/roles';

export const trackingRouter = Router();

// DEPRECATED: Legacy endpoint - kept for backward compatibility
trackingRouter.post('/me/location', requireAuth, requireRole(ROLES.DRIVER), trackingController.updateMyLocation);

// NEW: Production HTTP batch upload endpoint
// POST /api/tracking/batch
trackingRouter.post(
    '/batch',
    requireAuth,
    requireRole(ROLES.DRIVER),
    trackingController.uploadBatch
);

// GET: Retrieve current cached location for a driver
// GET /api/tracking/driver/:driverId/location
trackingRouter.get(
    '/driver/:driverId/location',
    requireAuth,
    trackingController.getDriverLocation
);

// GET: Retrieve current cached location for a trip
// GET /api/tracking/trip/:tripId/location
trackingRouter.get(
    '/trip/:tripId/location',
    requireAuth,
    trackingController.getTripLocation
);

// GET: Retrieve current cached location for a bus
// GET /api/tracking/bus/:busId/location
trackingRouter.get(
    '/bus/:busId/location',
    requireAuth,
    trackingController.getBusLocation
);
