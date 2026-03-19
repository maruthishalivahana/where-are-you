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

export const ENV = {
    PORT: process.env.PORT || 3000,
    MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/where-you-are',
    NODE_ENV: process.env.NODE_ENV || 'development',
    JWT_SECRET: process.env.JWT_SECRET || 'change-me-secret',
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
    REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET || 'change-me-refresh-secret',
    REFRESH_TOKEN_EXPIRES_IN: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',
    TRACKING_UPDATE_INTERVAL_MS: parseNumber(process.env.TRACKING_UPDATE_INTERVAL_MS, 5000),
    TRACKING_MOVEMENT_THRESHOLD_METERS: parseNumber(process.env.TRACKING_MOVEMENT_THRESHOLD_METERS, 10),
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || '',
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY || '',
    FRONTEND_URLS: parseOrigins(),
    MOBILE_APP_ORIGINS: parseMobileOrigins(),
};
