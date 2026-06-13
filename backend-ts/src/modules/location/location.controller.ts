import { Request, Response } from 'express';
import { locationService } from './location.service';
import { logger } from '../../utils/logger';

const getMessage = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    return 'Internal server error';
};

const getStatusCode = (error: unknown): number => {
    if (!error || typeof error !== 'object') {
        return 500;
    }

    const statusCode = (error as Record<string, unknown>).statusCode;
    return typeof statusCode === 'number' ? statusCode : 500;
};

export const locationController = {
    async searchLocations(req: Request, res: Response): Promise<void> {
        const query = String(req.query.q ?? '').trim();
        const startTime = Date.now();

        try {
            const results = await locationService.searchLocations(query);
            const durationMs = Date.now() - startTime;

            logger.info('Location search completed', {
                query,
                durationMs,
                resultsCount: results.length,
            });

            res.status(200).json({
                success: true,
                data: results,
            });
        } catch (error) {
            const statusCode = getStatusCode(error);
            const message = getMessage(error);
            const durationMs = Date.now() - startTime;

            logger.error('Location search failed', {
                query,
                message,
                durationMs,
            });

            if (statusCode === 504) {
                res.status(504).json({ success: false, message: 'Location provider timed out' });
                return;
            }

            if (statusCode === 502) {
                res.status(502).json({ success: false, message: 'Location provider unavailable' });
                return;
            }

            res.status(statusCode === 400 ? 400 : 500).json({
                success: false,
                message: statusCode === 400 ? message : 'Failed to search locations',
            });
        }
    },
};
