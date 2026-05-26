import Redis from 'ioredis';
import { ENV } from './env.config';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;

const initializeRedis = (): Redis => {
    if (redisClient) {
        return redisClient;
    }

    try {
        const redisConfig: any = {
            host: ENV.REDIS_HOST,
            port: Number(ENV.REDIS_PORT),
            password: ENV.REDIS_PASSWORD,
            db: Number(ENV.REDIS_DB) || 0,

            retryStrategy: (times: number) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },

            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            enableOfflineQueue: true,
        };

        // Enable TLS for Redis Cloud (port 6380 typically indicates TLS)
        if (Number(ENV.REDIS_PORT) === 6380 || process.env.REDIS_TLS === 'true') {
            redisConfig.tls = {
                rejectUnauthorized: false,
            };
        }

        redisClient = new Redis(redisConfig);

        // EVENTS

        redisClient.on('connect', () => {
            logger.info('Redis socket connected');
        });

        redisClient.on('ready', () => {
            logger.info('Redis ready to use');
        });

        redisClient.on('error', (error) => {
            logger.error(`Redis error: ${error.message}`);
        });

        redisClient.on('reconnecting', () => {
            logger.warn('Redis reconnecting...');
        });

        redisClient.on('close', () => {
            logger.warn('Redis connection closed');
        });

        return redisClient;

    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : 'Unknown Redis error';

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

        logger.info('Redis connection closed gracefully');
    }
};