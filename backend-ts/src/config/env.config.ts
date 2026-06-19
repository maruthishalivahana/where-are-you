import * as dotenv from 'dotenv';
dotenv.config();

const parseNumber = (value: string | undefined, fallback: number): number => {
    if (!value) {
        return fallback;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '');

const parseOrigins = (): string[] => {
    const configuredOrigins = [
        process.env.FRONTEND_URL,
        process.env.FRONTEND_DRIVER_USER_URL,
        ...(process.env.FRONTEND_URLS
            ? process.env.FRONTEND_URLS.split(',').map((origin) => origin.trim())
            : []),
    ]
        .map((origin) => normalizeOrigin((origin || '').trim()))
        .filter((origin) => origin.length > 0);

    return Array.from(new Set(configuredOrigins));
};

const parseMobileOrigins = (): string[] => {
    if (!process.env.MOBILE_APP_ORIGINS) {
        return [];
    }

    return Array.from(
        new Set(
            process.env.MOBILE_APP_ORIGINS
                .split(',')
                .map((origin) => normalizeOrigin(origin))
                .filter((origin) => origin.length > 0)
        )
    );
};

// ---------------------------------------------------------------------------
// Startup security validation — fail fast on missing / placeholder secrets
// ---------------------------------------------------------------------------
const PLACEHOLDER_SECRETS = new Set([
    'change-me-secret',
    'change-me-refresh-secret',
    'your-jwt-secret',
    'secret',
    '',
]);

const requireSecret = (envVarName: string): string => {
    const value = process.env[envVarName];
    if (!value || PLACEHOLDER_SECRETS.has(value.trim())) {
        throw new Error(
            `FATAL: Environment variable "${envVarName}" is missing or uses a placeholder value. ` +
            `Set a cryptographically random secret before starting the server.`
        );
    }
    return value.trim();
};

export const ENV = {
    PORT: process.env.PORT || 3000,
    MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/where-you-are',
    NODE_ENV: process.env.NODE_ENV || 'development',
    JWT_SECRET: requireSecret('JWT_SECRET'),
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
    REFRESH_TOKEN_SECRET: requireSecret('REFRESH_TOKEN_SECRET'),
    REFRESH_TOKEN_EXPIRES_IN: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',
    TRACKING_UPDATE_INTERVAL_MS: parseNumber(process.env.TRACKING_UPDATE_INTERVAL_MS, 5000),
    TRACKING_MOVEMENT_THRESHOLD_METERS: parseNumber(process.env.TRACKING_MOVEMENT_THRESHOLD_METERS, 10),
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || '',
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY || '',
    TRACKING_TIMEZONE: process.env.TRACKING_TIMEZONE || process.env.APP_TIMEZONE || 'UTC',
    REDIS_HOST: process.env.REDIS_HOST || 'localhost',
    REDIS_PORT: parseNumber(process.env.REDIS_PORT, 6379),
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    REDIS_DB: parseNumber(process.env.REDIS_DB, 0),
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
    RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL || 'NavixGo <onboarding@resend.dev>',
    EMAIL_QUEUE_ENABLED: process.env.EMAIL_QUEUE_ENABLED !== 'false',
    FRONTEND_URLS: parseOrigins(),
    MOBILE_APP_ORIGINS: parseMobileOrigins(),
};
