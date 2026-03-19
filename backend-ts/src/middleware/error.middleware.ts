import { NextFunction, Request, Response } from 'express';
import { ENV } from '../config/env.config';
import { logger } from '../utils/logger';

const getNumericErrorField = (
    error: unknown,
    key: 'status' | 'statusCode'
): number | undefined => {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const value = (error as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : undefined;
};

const getStringErrorField = (error: unknown, key: string): string | undefined => {
    if (!error || typeof error !== 'object') {
        return undefined;
    }

    const value = (error as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
};

const isJsonParseError = (error: unknown): boolean => {
    if (!(error instanceof SyntaxError)) {
        return false;
    }

    const status = getNumericErrorField(error, 'status');
    const type = getStringErrorField(error, 'type');

    return status === 400 && type === 'entity.parse.failed';
};

export const notFoundHandler = (req: Request, res: Response): void => {
    res.status(404).json({
        message: 'Route not found',
        path: req.originalUrl,
    });
};

export const errorHandler = (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction
): void => {
    if (res.headersSent) {
        next(error);
        return;
    }

    let statusCode =
        getNumericErrorField(error, 'statusCode') ?? getNumericErrorField(error, 'status') ?? 500;
    let message = 'Internal server error';

    if (isJsonParseError(error)) {
        statusCode = 400;
        message = 'Invalid JSON payload';
    } else if (error instanceof Error) {
        if (error.message.startsWith('CORS blocked for origin:')) {
            statusCode = 403;
            message = 'Request origin is not allowed by CORS policy';
        } else if (statusCode < 500 && error.message) {
            message = error.message;
        }
    }

    const serializedError =
        error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { value: error };

    logger.error(
        `HTTP ${req.method} ${req.originalUrl} failed with ${statusCode}`,
        serializedError
    );

    const responseBody: Record<string, unknown> = { message };

    if (ENV.NODE_ENV !== 'production') {
        responseBody.error = serializedError;
    }

    res.status(statusCode).json(responseBody);
};
