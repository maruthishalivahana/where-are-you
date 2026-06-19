import { Queue, Worker, Job } from 'bullmq';
import { Resend } from 'resend';
import { getRedisClient } from '../../config/redis.config';
import { ENV } from '../../config/env.config';
import { EmailLog } from './email.model';
import { logger } from '../../utils/logger';

// ──────────────────────────────────────────────
// Queue & Worker for async email delivery
// ──────────────────────────────────────────────

const QUEUE_NAME = 'email-delivery';

let emailQueue: Queue | null = null;
let emailWorker: Worker | null = null;

export interface EmailJobData {
    emailLogId: string;
    to: string;
    subject: string;
    html: string;
    from?: string;
}

/**
 * Get or create the email queue instance.
 * Reuses the existing Redis connection from redis.config.
 */
export const getEmailQueue = (): Queue => {
    if (emailQueue) {
        return emailQueue;
    }

    const redisClient = getRedisClient();
    const connection = redisClient.duplicate();

    emailQueue = new Queue(QUEUE_NAME, {
        connection,
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000,
            },
            removeOnComplete: {
                count: 1000,
                age: 7 * 24 * 3600, // 7 days
            },
            removeOnFail: {
                count: 5000,
                age: 30 * 24 * 3600, // 30 days
            },
        },
    });

    return emailQueue;
};

/**
 * Enqueue an email for delivery.
 */
export const enqueueEmail = async (data: EmailJobData): Promise<void> => {
    const queue = getEmailQueue();

    await queue.add('send-email', data, {
        priority: 1,
    });

    logger.info(`[EMAIL QUEUED] to=${data.to} subject="${data.subject}" logId=${data.emailLogId}`);
};

/**
 * Process a single email job via Resend.
 */
const processEmailJob = async (job: Job<EmailJobData>): Promise<void> => {
    const { emailLogId, to, subject, html, from } = job.data;

    logger.info(`[EMAIL PROCESSING] jobId=${job.id} to=${to} subject="${subject}" attempt=${job.attemptsMade + 1}`);

    if (!ENV.RESEND_API_KEY) {
        logger.warn('[EMAIL SKIPPED] RESEND_API_KEY not configured. Email not sent.');

        await EmailLog.findByIdAndUpdate(emailLogId, {
            status: 'failed',
            errorMessage: 'RESEND_API_KEY not configured',
        });

        return;
    }

    const resend = new Resend(ENV.RESEND_API_KEY);

    const senderAddress = from || ENV.RESEND_FROM_EMAIL;

    try {
        const result = await resend.emails.send({
            from: senderAddress,
            to: [to],
            subject,
            html,
        });

        if (result.error) {
            throw new Error(result.error.message || 'Resend API returned an error');
        }

        const messageId = result.data?.id || null;

        await EmailLog.findByIdAndUpdate(emailLogId, {
            status: 'sent',
            resendMessageId: messageId,
            sentAt: new Date(),
            errorMessage: null,
        });

        logger.info(`[EMAIL SENT] to=${to} resendId=${messageId} jobId=${job.id}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        await EmailLog.findByIdAndUpdate(emailLogId, {
            status: 'failed',
            errorMessage,
            $inc: { retryCount: 1 },
        });

        logger.error(`[EMAIL FAILED] to=${to} error="${errorMessage}" attempt=${job.attemptsMade + 1}/${job.opts.attempts || 3}`);

        // Re-throw to trigger BullMQ retry
        throw error;
    }
};

/**
 * Initialize the email worker.
 * Call this once during server startup.
 */
export const initializeEmailQueue = (): void => {
    if (!ENV.EMAIL_QUEUE_ENABLED) {
        logger.info('[EMAIL QUEUE] Disabled via EMAIL_QUEUE_ENABLED=false');
        return;
    }

    // Ensure the queue is created
    getEmailQueue();

    const redisClient = getRedisClient();
    const connection = redisClient.duplicate();

    emailWorker = new Worker(
        QUEUE_NAME,
        processEmailJob,
        {
            connection,
            concurrency: 5,
            limiter: {
                max: 10,
                duration: 1000, // Max 10 emails per second
            },
        }
    );

    emailWorker.on('completed', (job) => {
        logger.debug(`[EMAIL WORKER] Job ${job.id} completed`);
    });

    emailWorker.on('failed', (job, error) => {
        const jobId = job?.id || 'unknown';
        const willRetry = (job?.attemptsMade || 0) < (job?.opts?.attempts || 3);

        if (willRetry) {
            logger.warn(`[EMAIL RETRY] jobId=${jobId} attempt=${job?.attemptsMade} error="${error.message}"`);
        } else {
            logger.error(`[EMAIL PERMANENTLY FAILED] jobId=${jobId} error="${error.message}"`);
        }
    });

    emailWorker.on('error', (error) => {
        logger.error(`[EMAIL WORKER ERROR] ${error.message}`);
    });

    logger.info('[EMAIL QUEUE] Worker initialized successfully');
};

/**
 * Gracefully shut down the email queue and worker.
 */
export const closeEmailQueue = async (): Promise<void> => {
    if (emailWorker) {
        await emailWorker.close();
        emailWorker = null;
        logger.info('[EMAIL QUEUE] Worker closed');
    }

    if (emailQueue) {
        await emailQueue.close();
        emailQueue = null;
        logger.info('[EMAIL QUEUE] Queue closed');
    }
};
