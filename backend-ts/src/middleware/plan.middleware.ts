import { NextFunction, Request, Response } from 'express';
import { planService } from '../modules/plan/plan.service';

export const requireActivePlan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!req.user?.organizationId) {
            res.status(401).json({ message: 'Unauthorized' });
            return;
        }

        await planService.requireActivePlan(req.user.organizationId);
        next();
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Active plan required';
        res.status(403).json({ message });
    }
};
