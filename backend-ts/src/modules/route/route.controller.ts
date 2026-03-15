import { Request, Response } from 'express';
import { routeService } from './route.service';

const getMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Something went wrong';

export const routeController = {
    createRoute: async (req: Request, res: Response): Promise<void> => {
        try {
            const { name, startLat, startLng, endLat, endLng } = req.body as {
                name: string;
                startLat: number;
                startLng: number;
                endLat: number;
                endLng: number;
            };

            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const route = await routeService.createRoute(req.user.organizationId, {
                name,
                startLat,
                startLng,
                endLat,
                endLng,
            });

            res.status(201).json({ route });
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    getRoutes: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const routes = await routeService.getRoutes(req.user.organizationId);
            res.status(200).json({ routes });
        } catch (error) {
            res.status(500).json({ message: getMessage(error) });
        }
    },

    getRouteById: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const routeId = String(req.params.routeId || '');
            if (!routeId) {
                res.status(400).json({ message: 'routeId is required' });
                return;
            }

            console.log('Requested routeId:', routeId);

            const route = await routeService.getRouteMapDataById(
                req.user.organizationId,
                routeId
            );

            console.log('Route fetched:', route);
            console.log('Encoded polyline:', route.polyline);

            res.status(200).json(route);
        } catch (error) {
            const message = getMessage(error);

            if (message === 'Route not found') {
                res.status(404).json({ message });
                return;
            }

            if (message.includes('Directions provider') || message.includes('Google Directions')) {
                res.status(502).json({ message });
                return;
            }

            res.status(500).json({ message });
        }
    },

    updateRoute: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const routeId = String(req.params.routeId || '');
            if (!routeId) {
                res.status(400).json({ message: 'routeId is required' });
                return;
            }

            const route = await routeService.updateRoute(
                req.user.organizationId,
                routeId,
                req.body
            );

            res.status(200).json({ route });
        } catch (error) {
            const message = getMessage(error);
            res.status(message === 'Route not found' ? 404 : 400).json({ message });
        }
    },

    getRouteDebugById: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const route = await routeService.getRouteDebugById(
                req.user.organizationId,
                String(req.params.id)
            );
            res.status(200).json(route);
        } catch (error) {
            res.status(404).json({ message: getMessage(error) });
        }
    },

    recalculateRoutePolyline: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const routeId = String(req.params.routeId || '');
            if (!routeId) {
                res.status(400).json({ message: 'routeId is required' });
                return;
            }

            const route = await routeService.recalculateRoutePolyline(
                req.user.organizationId,
                routeId
            );
            res.status(200).json({ route });
        } catch (error) {
            const message = getMessage(error);

            if (message.includes('Directions provider') || message.includes('Google Directions')) {
                res.status(502).json({ message });
                return;
            }

            res.status(400).json({ message });
        }
    },

    deleteRoute: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const routeId = String(req.params.routeId || '');
            if (!routeId) {
                res.status(400).json({ message: 'routeId is required' });
                return;
            }

            const result = await routeService.deleteRoute(req.user.organizationId, routeId);
            res.status(200).json(result);
        } catch (error) {
            res.status(404).json({ message: getMessage(error) });
        }
    },
};
