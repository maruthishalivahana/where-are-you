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

    logger.info(`[FCM SEND] token=${fcmToken.substring(0, 15)}..., title=${title}`);

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

    logger.info(`[VOICE MESSAGE] voiceMessage="${data.voiceMessage || ''}"`);
    logger.info(`[FCM PAYLOAD BEFORE SEND] ${JSON.stringify(message)}`);

    try {
        const messageId = await messaging.send(message);
        logger.info(`[FCM SUCCESS] messageId=${messageId}, token=${fcmToken.substring(0, 15)}...`);
        logger.info(`[VOICE MESSAGE SENT] voiceMessage="${data.voiceMessage || ''}"`);
        logger.info(`[FCM SEND SUCCESS] messageId=${messageId}`);
    } catch (error: any) {
        const errorCode = error?.code || 'unknown';
        const errorMessage = error instanceof Error ? error.message : 'Unknown push error';
        logger.error(`[FCM FAILURE] token=${fcmToken.substring(0, 15)}..., errorCode=${errorCode}, error=${errorMessage}`);

        // Re-throw so callers can handle invalid tokens
        throw error;
    }
};
