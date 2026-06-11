import { getFirebaseMessaging } from '../config/firebase.config';
import { logger } from './logger';

interface SendPushParams {
    fcmToken: string;
    title: string;
    body: string;
    data?: Record<string, string>;
}

export const sendPushNotification = async ({
    fcmToken,
    title,
    body,
    data = {},
}: SendPushParams): Promise<void> => {
    const messaging = getFirebaseMessaging();
    if (!messaging) {
        logger.warn('[FCM] Firebase messaging not initialized — push notification skipped');
        return;
    }

    const message = {
        token: fcmToken,
        notification: {
            title,
            body,
        },
        data,
        android: {
            priority: 'high' as const,
            notification: {
                title,
                body,
                channelId: 'default',
                priority: 'high' as const,
                defaultSound: true,
                defaultVibrateTimings: true,
                notificationCount: 1,
            },
        },
        apns: {
            payload: {
                aps: {
                    alert: {
                        title,
                        body,
                    },
                    sound: 'default',
                    badge: 1,
                },
            },
        },
    };

    try {
        const messageId = await messaging.send(message);
        logger.info(`[FCM] Push sent successfully — messageId: ${messageId}, token: ${fcmToken.substring(0, 15)}...`);
    } catch (error: any) {
        const errorCode = error?.code || 'unknown';
        const errorMessage = error instanceof Error ? error.message : 'Unknown push error';
        logger.error(`[FCM] Push notification FAILED — code: ${errorCode}, message: ${errorMessage}, token: ${fcmToken.substring(0, 15)}...`);

        // Re-throw so callers can handle invalid tokens
        throw error;
    }
};
