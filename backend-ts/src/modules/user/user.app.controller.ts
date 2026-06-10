import { Request, Response } from 'express';
import { userService } from './user.service';

const getMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Something went wrong';

export const userAppController = {
    searchBuses: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const numberPlate = String(req.query.numberPlate || '').trim();
            if (!numberPlate) {
                res.status(400).json({ message: 'numberPlate query is required' });
                return;
            }

            const buses = await userService.searchBusesForUser(req.user.organizationId, numberPlate);
            res.status(200).json({ buses });
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    getLiveBus: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const data = await userService.getLiveBusForUser(
                req.user.organizationId,
                String(req.params.busId)
            );

            res.status(200).json(data);
        } catch (error) {
            const message = getMessage(error);
            res.status(message === 'Bus not found' ? 404 : 400).json({ message });
        }
    },

    subscribeBus: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const subscription = await userService.subscribeToBus(
                req.user.organizationId,
                req.user.sub,
                req.body
            );

            res.status(201).json({ subscription });
        } catch (error) {
            const message = getMessage(error);
            const status =
                message === 'Bus not found' || message === 'Stop not found'
                    ? 404
                    : 400;

            res.status(status).json({ message });
        }
    },

    getMySubscriptions: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const subscriptions = await userService.getMySubscriptions(
                req.user.organizationId,
                req.user.sub
            );

            res.status(200).json({ subscriptions });
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    unsubscribeBus: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const result = await userService.unsubscribeFromBus(
                req.user.organizationId,
                req.user.sub,
                String(req.params.subscriptionId)
            );

            res.status(200).json(result);
        } catch (error) {
            const message = getMessage(error);
            res.status(message === 'Subscription not found' ? 404 : 400).json({ message });
        }
    },

    updateMyFcmToken: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const fcmToken = String(req.body?.fcmToken || '').trim();
            if (!fcmToken) {
                res.status(400).json({ message: 'fcmToken is required' });
                console.log
                return;
            }

            const user = await userService.updateMyFcmToken(
                req.user.organizationId,
                req.user.sub,
                fcmToken
            );

            res.status(200).json({ user });
        } catch (error) {
            const message = getMessage(error);
            res.status(message === 'User not found' ? 404 : 400).json({ message });
        }
    },

    /**
     * PHASE 4: Get passenger automatic tracking data
     * New endpoint for auto passenger tracking flow
     * 
     * Flow:
     * 1. User authenticated (token in header)
     * 2. Get user's assigned route
     * 3. Get active trip on that route
     * 4. Return route + trip + bus + driver
     * 5. Frontend joins socket trip room with tripId
     * 
     * Response:
     * - No route assigned: return null values with message
     * - Route exists, no active trip: return route + nulls (bus in parking)
     * - Active trip: return all data ready for socket connection
     */
    getTrackingData: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ success: false, message: 'Unauthorized' });
                return;
            }

            const trackingData = await userService.getPassengerTrackingData(
                req.user.sub,
                req.user.organizationId
            );

            // If user has no route assigned
            if (!trackingData.route) {
                res.status(400).json({
                    success: false,
                    message: trackingData.message,
                    data: {
                        route: null,
                        stops: null,
                        trip: null,
                        bus: null,
                        driver: null,
                    },
                });
                return;
            }

            // If route exists but no active trip
            if (!trackingData.trip) {
                res.status(200).json({
                    success: true,
                    message: trackingData.message,
                    data: {
                        route: trackingData.route,
                        stops: trackingData.stops,
                        trip: null,
                        bus: null,
                        driver: null,
                    },
                });
                return;
            }

            // If active trip exists, return all data
            res.status(200).json({
                success: true,
                message: trackingData.message,
                data: {
                    route: trackingData.route,
                    stops: trackingData.stops,
                    trip: trackingData.trip,
                    bus: trackingData.bus,
                    driver: trackingData.driver,
                },
            });
        } catch (error) {
            const message = getMessage(error);
            res.status(400).json({
                success: false,
                message,
                data: {
                    route: null,
                    stops: null,
                    trip: null,
                    bus: null,
                    driver: null,
                },
            });
        }
    },

    /**
     * Get available routes for user to select
     * GET /api/user/routes
     */
    getAvailableRoutes: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const routes = await userService.getAvailableRoutes(req.user.organizationId);
            res.status(200).json({
                success: true,
                data: routes,
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                message: getMessage(error),
            });
        }
    },

    /**
     * Get stops for a specific route
     * GET /api/user/routes/:routeId/stops
     */
    getRouteStops: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const routeId = String(req.params.routeId).trim();
            if (!routeId) {
                res.status(400).json({ message: 'routeId is required' });
                return;
            }

            const stops = await userService.getRouteStops(req.user.organizationId, routeId);
            res.status(200).json({
                success: true,
                data: stops,
            });
        } catch (error) {
            const message = getMessage(error);
            const status = message === 'Route not found' ? 404 : 400;
            res.status(status).json({
                success: false,
                message,
            });
        }
    },

    /**
     * Assign stop to user
     * POST /api/user/profile/assigned-stop
     */
    assignStop: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const { routeId, stopId } = req.body;
            if (!routeId || !stopId) {
                res.status(400).json({
                    message: 'routeId and stopId are required',
                });
                return;
            }

            const user = await userService.assignStop(
                req.user.sub,
                req.user.organizationId,
                routeId,
                stopId
            );

            res.status(200).json({
                success: true,
                message: 'Stop assigned successfully',
                data: {
                    userId: user._id,
                    routeId: user.routeId,
                    stopId: user.stopId,
                },
            });
        } catch (error) {
            const message = getMessage(error);
            const status =
                message === 'User not found' ||
                message === 'Route not found' ||
                message === 'Stop not found'
                    ? 404
                    : 400;
            res.status(status).json({
                success: false,
                message,
            });
        }
    },

    /**
     * Get user's assigned stop
     * GET /api/user/profile/assigned-stop
     */
    getAssignedStop: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const assignedStop = await userService.getAssignedStop(
                req.user.sub,
                req.user.organizationId
            );

            res.status(200).json({
                success: true,
                data: assignedStop,
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                message: getMessage(error),
            });
        }
    },

    /**
     * Get user's profile details including FCM token
     * GET /api/user/profile
     */
    getProfile: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId || !req.user.sub) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const profile = await userService.getMyProfile(
                req.user.sub,
                req.user.organizationId
            );

            res.status(200).json({
                success: true,
                ...profile,
                user: profile,
                data: profile,
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                message: getMessage(error),
            });
        }
    },
};
