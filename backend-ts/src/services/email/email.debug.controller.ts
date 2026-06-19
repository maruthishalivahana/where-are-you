import { Request, Response } from 'express';
import { emailService } from './email.service';
import { triggerDailyExpiryCheck } from './email.scheduler';
import { getEmailQueue } from './email.queue';
import { EmailLog } from './email.model';
import { logger } from '../../utils/logger';

export const emailDebugController = {
    /**
     * POST /api/debug/email/test-send
     *
     * Send a test template or custom email to an arbitrary recipient.
     *
     * Request Body:
     * {
     *   "to": "string (recipient email, required)",
     *   "templateName": "WELCOME" | "TRIAL_ACTIVATED" | "TRIAL_EXPIRING" | "PAYMENT_SUCCESS" | "PAYMENT_FAILED" | "PLAN_EXPIRED" | "CUSTOM",
     *   "data": { ...template parameters or subject/html for CUSTOM... }
     * }
     */
    testSend: async (req: Request, res: Response): Promise<void> => {
        try {
            const organizationId = req.user?.organizationId;
            const adminId = req.user?.sub;

            const { to, templateName, data } = req.body;

            if (!to || typeof to !== 'string') {
                res.status(400).json({ message: 'to (recipient email) is required' });
                return;
            }

            if (!templateName || typeof templateName !== 'string') {
                res.status(400).json({ message: 'templateName is required' });
                return;
            }

            const templateData = data || {};
            const upperTemplate = templateName.toUpperCase();

            switch (upperTemplate) {
                case 'WELCOME':
                    await emailService.sendWelcomeEmail({
                        adminEmail: to,
                        adminName: templateData.adminName || 'Test Admin',
                        organizationName: templateData.organizationName || 'Test Org Inc.',
                        organizationId: organizationId ? String(organizationId) : undefined,
                        adminId: adminId ? String(adminId) : undefined,
                        loginUrl: templateData.loginUrl || 'https://navixgo.in/login',
                    });
                    break;

                case 'TRIAL_ACTIVATED':
                    await emailService.sendTrialActivatedEmail({
                        adminEmail: to,
                        adminName: templateData.adminName || 'Test Admin',
                        organizationName: templateData.organizationName || 'Test Org Inc.',
                        organizationId: organizationId ? String(organizationId) : undefined,
                        busLimit: typeof templateData.busLimit === 'number' ? templateData.busLimit : 5,
                        expiryDate: templateData.expiryDate || new Date(Date.now() + 7 * 24 * 3600 * 1000).toLocaleDateString(),
                    });
                    break;

                case 'TRIAL_EXPIRING':
                    await emailService.sendTrialExpiringEmail({
                        adminEmail: to,
                        adminName: templateData.adminName || 'Test Admin',
                        organizationName: templateData.organizationName || 'Test Org Inc.',
                        organizationId: organizationId ? String(organizationId) : undefined,
                        daysRemaining: typeof templateData.daysRemaining === 'number' ? templateData.daysRemaining : 2,
                        upgradeUrl: templateData.upgradeUrl || 'https://navixgo.in/upgrade',
                    });
                    break;

                case 'PAYMENT_SUCCESS':
                    await emailService.sendPaymentSuccessEmail({
                        adminEmail: to,
                        adminName: templateData.adminName || 'Test Admin',
                        organizationId: organizationId ? String(organizationId) : undefined,
                        planName: templateData.planName || 'Growth Plan',
                        busCount: typeof templateData.busCount === 'number' ? templateData.busCount : 10,
                        amount: templateData.amount || '4999',
                        currency: templateData.currency || 'INR',
                        expiryDate: templateData.expiryDate || new Date(Date.now() + 30 * 24 * 3600 * 1000).toLocaleDateString(),
                    });
                    break;

                case 'PAYMENT_FAILED':
                    await emailService.sendPaymentFailedEmail({
                        adminEmail: to,
                        adminName: templateData.adminName || 'Test Admin',
                        organizationId: organizationId ? String(organizationId) : undefined,
                        planName: templateData.planName || 'Growth Plan',
                        reason: templateData.reason || 'Insufficient funds in customer card',
                        retryUrl: templateData.retryUrl || 'https://navixgo.in/billing/retry',
                    });
                    break;

                case 'PLAN_EXPIRED':
                    await emailService.sendPlanExpiredEmail({
                        adminEmail: to,
                        adminName: templateData.adminName || 'Test Admin',
                        organizationName: templateData.organizationName || 'Test Org Inc.',
                        organizationId: organizationId ? String(organizationId) : undefined,
                        expiredPlanName: templateData.expiredPlanName || 'Growth Plan',
                        renewUrl: templateData.renewUrl || 'https://navixgo.in/billing/renew',
                    });
                    break;

                case 'CUSTOM':
                    if (!templateData.subject || !templateData.html) {
                        res.status(400).json({ message: 'Custom email requires subject and html fields inside data' });
                        return;
                    }
                    await emailService.sendEmail({
                        to,
                        recipientName: templateData.recipientName || 'Recipient',
                        recipientRole: templateData.recipientRole || 'admin',
                        organizationId: organizationId ? String(organizationId) : undefined,
                        templateName: 'CUSTOM',
                        subject: templateData.subject,
                        html: templateData.html,
                    });
                    break;

                default:
                    res.status(400).json({
                        message: `Invalid templateName. Supported values: WELCOME, TRIAL_ACTIVATED, TRIAL_EXPIRING, PAYMENT_SUCCESS, PAYMENT_FAILED, PLAN_EXPIRED, CUSTOM`,
                    });
                    return;
            }

            res.status(200).json({
                message: `Email task enqueued successfully using template '${upperTemplate}'.`,
                recipient: to,
                simulatedAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('[EmailDebugController] testSend error:', error);
            res.status(500).json({
                message: error instanceof Error ? error.message : 'Unknown error occurred',
            });
        }
    },

    /**
     * GET /api/debug/email/logs
     *
     * List email delivery logs. Supports optional filters.
     */
    getLogs: async (req: Request, res: Response): Promise<void> => {
        try {
            const organizationId = req.user?.organizationId;
            const { page, limit, status, allTenants } = req.query;

            const options = {
                page: page ? parseInt(page as string, 10) : 1,
                limit: limit ? parseInt(limit as string, 10) : 20,
                status: status ? String(status) : undefined,
            };

            let result;
            
            // If allTenants is true, bypass organization filter to check all system logs (for testing)
            if (allTenants === 'true') {
                const skip = (options.page - 1) * options.limit;
                const filter: Record<string, unknown> = {};
                if (options.status) {
                    filter.status = options.status;
                }

                const [logs, total] = await Promise.all([
                    EmailLog.find(filter)
                        .sort({ createdAt: -1 })
                        .skip(skip)
                        .limit(options.limit)
                        .lean(),
                    EmailLog.countDocuments(filter),
                ]);

                result = {
                    logs,
                    total,
                    page: options.page,
                    limit: options.limit,
                    totalPages: Math.ceil(total / options.limit),
                };
            } else {
                if (!organizationId) {
                    res.status(400).json({ message: 'organizationId not found in user context' });
                    return;
                }
                result = await emailService.getEmailLogs(String(organizationId), options);
            }

            res.status(200).json(result);
        } catch (error) {
            logger.error('[EmailDebugController] getLogs error:', error);
            res.status(500).json({
                message: error instanceof Error ? error.message : 'Unknown error occurred',
            });
        }
    },

    /**
     * GET /api/debug/email/stats
     *
     * Get email statistics from DB and BullMQ queue health.
     */
    getStats: async (req: Request, res: Response): Promise<void> => {
        try {
            const organizationId = req.user?.organizationId;
            const { allTenants } = req.query;

            let dbStats;
            if (allTenants === 'true') {
                const [queued, sent, failed] = await Promise.all([
                    EmailLog.countDocuments({ status: 'queued' }),
                    EmailLog.countDocuments({ status: 'sent' }),
                    EmailLog.countDocuments({ status: 'failed' }),
                ]);
                dbStats = { queued, sent, failed, total: queued + sent + failed };
            } else {
                if (!organizationId) {
                    res.status(400).json({ message: 'organizationId not found in user context' });
                    return;
                }
                dbStats = await emailService.getEmailStats(String(organizationId));
            }

            // Fetch BullMQ Queue Stats
            let queueStats = null;
            try {
                const queue = getEmailQueue();
                const counts = await queue.getJobCounts('active', 'completed', 'failed', 'delayed', 'waiting');
                queueStats = {
                    active: counts.active,
                    completed: counts.completed,
                    failed: counts.failed,
                    delayed: counts.delayed,
                    waiting: counts.waiting,
                };
            } catch (queueErr: any) {
                logger.warn(`[EmailDebugController] Failed to retrieve BullMQ stats: ${queueErr.message}`);
            }

            res.status(200).json({
                dbStats,
                queueStats,
            });
        } catch (error) {
            logger.error('[EmailDebugController] getStats error:', error);
            res.status(500).json({
                message: error instanceof Error ? error.message : 'Unknown error occurred',
            });
        }
    },

    /**
     * POST /api/debug/email/trigger-scheduler
     *
     * Trigger the daily subscription expiration email scheduler manually.
     */
    triggerScheduler: async (req: Request, res: Response): Promise<void> => {
        try {
            logger.info('[EmailDebugController] Manual trigger of daily plan expiry check initiated');
            await triggerDailyExpiryCheck();
            res.status(200).json({
                message: 'Daily plan expiry check triggered manually and executed successfully.',
                triggeredAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('[EmailDebugController] triggerScheduler error:', error);
            res.status(500).json({
                message: error instanceof Error ? error.message : 'Unknown error occurred',
            });
        }
    },
};
