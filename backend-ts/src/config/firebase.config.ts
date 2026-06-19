import admin from 'firebase-admin';
import { ENV } from './env.config';
import { logger } from '../utils/logger';

let initialized = false;

export const getFirebaseApp = (): admin.app.App | null => {
    if (admin.apps.length > 0) {
        initialized = true;
        return admin.app();
    }

    const hasConfig =
        ENV.FIREBASE_PROJECT_ID &&
        ENV.FIREBASE_CLIENT_EMAIL &&
        ENV.FIREBASE_PRIVATE_KEY;

    if (!hasConfig) {
        logger.error('❌ Firebase configuration missing');
        logger.error(`PROJECT_ID: ${ENV.FIREBASE_PROJECT_ID}`);
        logger.error(`CLIENT_EMAIL: ${ENV.FIREBASE_CLIENT_EMAIL}`);
        logger.error(`PRIVATE_KEY_EXISTS: ${!!ENV.FIREBASE_PRIVATE_KEY}`);

        initialized = true;
        return null;
    }

    try {
        // ==========================================
        // FIREBASE DEBUG LOGS
        // ==========================================

        logger.info('========== FIREBASE DIAGNOSTICS ==========');

        logger.info(
            `PROJECT_ID: ${ENV.FIREBASE_PROJECT_ID}`
        );

        logger.info(
            `CLIENT_EMAIL: ${ENV.FIREBASE_CLIENT_EMAIL}`
        );

        logger.info(
            `PRIVATE_KEY_EXISTS: ${!!ENV.FIREBASE_PRIVATE_KEY}`
        );

        logger.info(
            `PRIVATE_KEY_LENGTH: ${
                ENV.FIREBASE_PRIVATE_KEY?.length || 0
            }`
        );

        logger.info(
            `STARTS_WITH_BEGIN: ${
                ENV.FIREBASE_PRIVATE_KEY?.includes(
                    '-----BEGIN PRIVATE KEY-----'
                ) || false
            }`
        );

        logger.info(
            `ENDS_WITH_END: ${
                ENV.FIREBASE_PRIVATE_KEY?.includes(
                    '-----END PRIVATE KEY-----'
                ) || false
            }`
        );

        logger.info(
            `NEWLINE_COUNT: ${
                (ENV.FIREBASE_PRIVATE_KEY?.match(/\\n/g) || []).length
            }`
        );

        logger.info(
            `FIREBASE_APPS_COUNT_BEFORE_INIT: ${admin.apps.length}`
        );

        logger.info('==========================================');

        // ==========================================
        // FIREBASE INIT
        // ==========================================

        const privateKey = ENV.FIREBASE_PRIVATE_KEY.replace(
            /\\n/g,
            '\n'
        );

        const app = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: ENV.FIREBASE_PROJECT_ID,
                clientEmail: ENV.FIREBASE_CLIENT_EMAIL,
                privateKey,
            }),
        });

        initialized = true;

        logger.info('✅ Firebase initialized successfully');
        logger.info(
            `FIREBASE_APPS_COUNT_AFTER_INIT: ${admin.apps.length}`
        );

        return app;
    } catch (error) {
        logger.error('❌ Firebase initialization failed');

        if (error instanceof Error) {
            logger.error(`MESSAGE: ${error.message}`);
            logger.error(`STACK: ${error.stack}`);
        }

        initialized = true;

        return null;
    }
};

export const getFirebaseMessaging = (): admin.messaging.Messaging | null => {
    const app = getFirebaseApp();

    if (!app) {
        logger.error(
            '❌ Firebase messaging unavailable because Firebase app is null'
        );
        return null;
    }

    try {
        const messaging = admin.messaging(app);

        logger.info('✅ Firebase messaging instance created');

        return messaging;
    } catch (error) {
        logger.error('❌ Failed to create Firebase messaging instance');

        if (error instanceof Error) {
            logger.error(`MESSAGE: ${error.message}`);
        }

        return null;
    }
};