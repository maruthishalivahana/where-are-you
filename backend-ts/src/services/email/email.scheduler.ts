import { Queue, Worker, Job } from 'bullmq';
import { getRedisClient } from '../../config/redis.config';
import { ENV } from '../../config/env.config';
import { OrganizationPlanSubscription } from '../../modules/plan/organizationPlan.model';
import { Admin } from '../../modules/admin/admin.model';
import { Organization } from '../../modules/organization/organization.model';
import { emailService } from './email.service';
import { logger } from '../../utils/logger';

// ──────────────────────────────────────────────
// BullMQ Repeatable Job — Daily Plan Expiry Check
// ──────────────────────────────────────────────

const SCHEDULER_QUEUE_NAME = 'email-scheduler';

let schedulerQueue: Queue | null = null;
let schedulerWorker: Worker | null = null;

/**
 * Process the daily expiry check job.
 *
 * 1. Find plans expiring within 2 days → send trial-expiring / plan-expiring email
 * 2. Find plans that expired today → send plan-expired email
 */
const processDailyExpiryCheck = async (_job: Job): Promise<void> => {
    logger.info('[EMAIL SCHEDULER] Running daily plan expiry check...');

    const now = new Date();

    // ── 1. Plans expiring within 2 days ──
    const twoDaysFromNow = new Date(now);
    twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    try {
        // Find subscriptions with active plans expiring in the next 2 days
        const expiringSubscriptions = await OrganizationPlanSubscription.find({
            currentPlanStatus: 'active',
            currentPlanEndsAt: {
                $gte: now,
                $lte: twoDaysFromNow,
            },
        }).lean();

        logger.info(`[EMAIL SCHEDULER] Found ${expiringSubscriptions.length} plan(s) expiring within 2 days`);

        for (const sub of expiringSubscriptions) {
            try {
                const admin = await Admin.findOne({ organizationId: sub.organizationId }).lean();
                const organization = await Organization.findById(sub.organizationId).lean();

                if (!admin || !admin.email || !organization) {
                    logger.warn(`[EMAIL SCHEDULER] Skipping org ${sub.organizationId}: admin or org not found`);
                    continue;
                }

                const daysRemaining = Math.max(
                    1,
                    Math.ceil((new Date(sub.currentPlanEndsAt!).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
                );

                const isTrial = sub.currentPlanActivationSource === 'trial';

                if (isTrial) {
                    await emailService.sendTrialExpiringEmail({
                        adminEmail: admin.email,
                        adminName: admin.name,
                        organizationName: organization.name,
                        organizationId: String(sub.organizationId),
                        daysRemaining,
                    });
                } else {
                    // For paid plans, send trial-expiring with different context
                    await emailService.sendTrialExpiringEmail({
                        adminEmail: admin.email,
                        adminName: admin.name,
                        organizationName: organization.name,
                        organizationId: String(sub.organizationId),
                        daysRemaining,
                    });
                }

                logger.info(
                    `[EMAIL SCHEDULER] Expiry reminder sent to ${admin.email} ` +
                    `(org=${organization.name}, daysRemaining=${daysRemaining})`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                logger.error(`[EMAIL SCHEDULER] Error sending expiry reminder for org ${sub.organizationId}: ${message}`);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[EMAIL SCHEDULER] Error querying expiring plans: ${message}`);
    }

    // ── 2. Plans that expired today ──
    try {
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        const endOfToday = new Date(now);
        endOfToday.setHours(23, 59, 59, 999);

        const expiredSubscriptions = await OrganizationPlanSubscription.find({
            currentPlanStatus: 'expired',
            currentPlanEndsAt: {
                $gte: startOfToday,
                $lte: endOfToday,
            },
        }).lean();

        logger.info(`[EMAIL SCHEDULER] Found ${expiredSubscriptions.length} plan(s) that expired today`);

        for (const sub of expiredSubscriptions) {
            try {
                const admin = await Admin.findOne({ organizationId: sub.organizationId }).lean();
                const organization = await Organization.findById(sub.organizationId).lean();

                if (!admin || !admin.email || !organization) {
                    logger.warn(`[EMAIL SCHEDULER] Skipping expired org ${sub.organizationId}: admin or org not found`);
                    continue;
                }

                await emailService.sendPlanExpiredEmail({
                    adminEmail: admin.email,
                    adminName: admin.name,
                    organizationName: organization.name,
                    organizationId: String(sub.organizationId),
                    expiredPlanName: sub.currentPlanName || 'Unknown Plan',
                });

                logger.info(
                    `[EMAIL SCHEDULER] Expiry notice sent to ${admin.email} ` +
                    `(org=${organization.name}, plan=${sub.currentPlanName})`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                logger.error(`[EMAIL SCHEDULER] Error sending expiry notice for org ${sub.organizationId}: ${message}`);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[EMAIL SCHEDULER] Error querying expired plans: ${message}`);
    }

    logger.info('[EMAIL SCHEDULER] Daily expiry check completed');
};

/**
 * Initialize the email scheduler.
 * Registers a BullMQ repeatable job that runs daily at 9:00 AM.
 * Survives server restarts (persisted in Redis).
 */
export const initializeEmailScheduler = async (): Promise<void> => {
    if (!ENV.EMAIL_QUEUE_ENABLED) {
        logger.info('[EMAIL SCHEDULER] Disabled via EMAIL_QUEUE_ENABLED=false');
        return;
    }

    const redisClient = getRedisClient();

    // Queue for scheduler jobs
    const queueConnection = redisClient.duplicate();
    schedulerQueue = new Queue(SCHEDULER_QUEUE_NAME, {
        connection: queueConnection,
    });

    // Remove any existing repeatable jobs to prevent duplicates on restart
    const existingRepeatable = await schedulerQueue.getRepeatableJobs();
    for (const job of existingRepeatable) {
        await schedulerQueue.removeRepeatableByKey(job.key);
    }

    // Register the daily expiry check at 9:00 AM
    await schedulerQueue.add(
        'daily-expiry-check',
        { type: 'daily-expiry-check' },
        {
            repeat: {
                pattern: '0 9 * * *', // Every day at 9:00 AM
            },
            removeOnComplete: {
                count: 30, // Keep last 30 runs
            },
            removeOnFail: {
                count: 100,
            },
        }
    );

    logger.info('[EMAIL SCHEDULER] Registered daily-expiry-check (cron: 0 9 * * *)');

    // Worker to process scheduler jobs
    const workerConnection = redisClient.duplicate();
    schedulerWorker = new Worker(
        SCHEDULER_QUEUE_NAME,
        async (job: Job) => {
            if (job.name === 'daily-expiry-check') {
                await processDailyExpiryCheck(job);
            } else {
                logger.warn(`[EMAIL SCHEDULER] Unknown job name: ${job.name}`);
            }
        },
        {
            connection: workerConnection,
            concurrency: 1,
        }
    );

    schedulerWorker.on('completed', (job) => {
        logger.info(`[EMAIL SCHEDULER] Job ${job.name} completed (id=${job.id})`);
    });

    schedulerWorker.on('failed', (job, error) => {
        logger.error(`[EMAIL SCHEDULER] Job ${job?.name} failed: ${error.message}`);
    });

    schedulerWorker.on('error', (error) => {
        logger.error(`[EMAIL SCHEDULER ERROR] ${error.message}`);
    });

    logger.info('[EMAIL SCHEDULER] Initialized successfully');
};

/**
 * Gracefully shut down the scheduler.
 */
export const closeEmailScheduler = async (): Promise<void> => {
    if (schedulerWorker) {
        await schedulerWorker.close();
        schedulerWorker = null;
    }

    if (schedulerQueue) {
        await schedulerQueue.close();
        schedulerQueue = null;
    }

    logger.info('[EMAIL SCHEDULER] Shut down gracefully');
};

/**
 * Manually trigger the daily plan expiry check logic for testing.
 */
export const triggerDailyExpiryCheck = async (): Promise<void> => {
    await processDailyExpiryCheck({ name: 'manual-trigger' } as any);
};

