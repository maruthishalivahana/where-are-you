import Redis from 'ioredis';
import { ENV } from './env.config';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;

const initializeRedis = (): Redis => {
    if (redisClient) {
        return redisClient;
    }

    try {
        redisClient = new Redis({
            host: ENV.REDIS_HOST || 'localhost',
            port: ENV.REDIS_PORT || 6379,
            password: ENV.REDIS_PASSWORD,
            db: ENV.REDIS_DB || 0,
            retryStrategy: (times: number) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            enableOfflineQueue: true,
        });

        redisClient.on('connect', () => {
            logger.info('Redis connected');
        });

        redisClient.on('error', (error) => {
            logger.error(`Redis error: ${error.message}`);
        });

        redisClient.on('reconnecting', () => {
            logger.warn('Redis reconnecting...');
        });

        return redisClient;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`Redis initialization failed: ${message}`);
        throw error;
    }
};

export const getRedisClient = (): Redis => {
    if (!redisClient) {
        return initializeRedis();
    }
    return redisClient;
};

export const closeRedis = async (): Promise<void> => {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
    }
};
