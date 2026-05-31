import { Request, Response } from 'express';
import { planService } from './plan.service';

const getMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Something went wrong';

export const planController = {
    listPlans: async (_req: Request, res: Response): Promise<void> => {
        try {
            const plans = await planService.listPlans();
            res.status(200).json({ plans });
        } catch (error) {
            res.status(500).json({ message: getMessage(error) });
        }
    },

    getCurrentPlan: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const currentPlan = await planService.getCurrentPlan(req.user.organizationId);
            res.status(200).json({ currentPlan });
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    getPlanSummary: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const summary = await planService.getPlanSummary(req.user.organizationId);
            res.status(200).json(summary);
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    activatePlan: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const planCode = String(req.body?.planCode || '').trim();
            const busCountRaw = req.body?.busCount;
            const busCount =
                typeof busCountRaw === 'number'
                    ? busCountRaw
                    : typeof busCountRaw === 'string' && busCountRaw.trim().length > 0
                        ? Number(busCountRaw)
                        : undefined;

            if (!planCode) {
                res.status(400).json({ message: 'planCode is required' });
                return;
            }

            const currentPlan = await planService.activatePlan(req.user.organizationId, {
                planCode,
                busCount,
            });

            res.status(200).json({ currentPlan });
        } catch (error) {
            const message = getMessage(error);
            res.status(message.includes('not found') ? 404 : 400).json({ message });
        }
    },
};
