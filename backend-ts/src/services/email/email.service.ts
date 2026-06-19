import { EmailLog, EmailPreference } from './email.model';
import { enqueueEmail } from './email.queue';
import { logger } from '../../utils/logger';

// ──────────────────────────────────────────────
// Template imports (lazy-loaded to avoid circular deps)
// ──────────────────────────────────────────────

import { welcomeTemplate } from './templates/welcome.template';
import { trialActivatedTemplate } from './templates/trial-activated.template';
import { trialExpiringTemplate } from './templates/trial-expiring.template';
import { paymentSuccessTemplate } from './templates/payment-success.template';
import { paymentFailedTemplate } from './templates/payment-failed.template';
import { planExpiredTemplate } from './templates/plan-expired.template';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface SendEmailParams {
    to: string;
    recipientName?: string;
    recipientRole?: 'admin' | 'user' | 'driver' | 'system';
    recipientId?: string;
    organizationId?: string;
    templateName: string;
    subject: string;
    html: string;
    metadata?: Record<string, unknown>;
}

interface WelcomeEmailParams {
    adminEmail: string;
    adminName: string;
    organizationName: string;
    organizationId?: string;
    adminId?: string;
    loginUrl?: string;
}

interface TrialActivatedEmailParams {
    adminEmail: string;
    adminName: string;
    organizationName: string;
    organizationId?: string;
    busLimit: number;
    expiryDate: string;
}

interface TrialExpiringEmailParams {
    adminEmail: string;
    adminName: string;
    organizationName: string;
    organizationId?: string;
    daysRemaining: number;
    upgradeUrl?: string;
}

interface PaymentSuccessEmailParams {
    adminEmail: string;
    adminName: string;
    organizationId?: string;
    planName: string;
    busCount: number;
    amount: string;
    currency: string;
    expiryDate: string;
}

interface PaymentFailedEmailParams {
    adminEmail: string;
    adminName: string;
    organizationId?: string;
    planName: string;
    reason?: string;
    retryUrl?: string;
}

interface PlanExpiredEmailParams {
    adminEmail: string;
    adminName: string;
    organizationName: string;
    organizationId?: string;
    expiredPlanName: string;
    renewUrl?: string;
}

interface EmailLogQuery {
    page?: number;
    limit?: number;
    status?: string;
}

// ──────────────────────────────────────────────
// Email Service — central orchestrator
// ──────────────────────────────────────────────

export const emailService = {
    /**
     * Core: Create an EmailLog record and enqueue for delivery.
     * This is the single entry point for all email sends.
     */
    sendEmail: async (params: SendEmailParams): Promise<void> => {
        try {
            // Create the email log record first
            const emailLog = await EmailLog.create({
                organizationId: params.organizationId || undefined,
                recipientEmail: params.to,
                recipientName: params.recipientName || undefined,
                recipientRole: params.recipientRole || 'admin',
                recipientId: params.recipientId || undefined,
                templateName: params.templateName,
                subject: params.subject,
                status: 'queued' as const,
                metadata: params.metadata || {},
            });

            // Enqueue for async delivery
            await enqueueEmail({
                emailLogId: String(emailLog._id),
                to: params.to,
                subject: params.subject,
                html: params.html,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            logger.error(`[EMAIL SERVICE] Failed to queue email: ${message}`, {
                to: params.to,
                template: params.templateName,
            });
        }
    },

    // ──────────────────────────────────────────
    // High-level template methods
    // ──────────────────────────────────────────

    sendWelcomeEmail: async (params: WelcomeEmailParams): Promise<void> => {
        const html = welcomeTemplate({
            adminName: params.adminName,
            organizationName: params.organizationName,
            loginUrl: params.loginUrl,
        });

        await emailService.sendEmail({
            to: params.adminEmail,
            recipientName: params.adminName,
            recipientRole: 'admin',
            recipientId: params.adminId,
            organizationId: params.organizationId,
            templateName: 'WELCOME',
            subject: `Welcome to NavixGo, ${params.adminName}!`,
            html,
            metadata: {
                organizationName: params.organizationName,
            },
        });
    },

    sendTrialActivatedEmail: async (params: TrialActivatedEmailParams): Promise<void> => {
        const html = trialActivatedTemplate({
            adminName: params.adminName,
            organizationName: params.organizationName,
            busLimit: params.busLimit,
            expiryDate: params.expiryDate,
        });

        await emailService.sendEmail({
            to: params.adminEmail,
            recipientName: params.adminName,
            recipientRole: 'admin',
            organizationId: params.organizationId,
            templateName: 'TRIAL_ACTIVATED',
            subject: 'Your NavixGo Free Trial is Active!',
            html,
            metadata: {
                organizationName: params.organizationName,
                busLimit: params.busLimit,
                expiryDate: params.expiryDate,
            },
        });
    },

    sendTrialExpiringEmail: async (params: TrialExpiringEmailParams): Promise<void> => {
        const html = trialExpiringTemplate({
            adminName: params.adminName,
            organizationName: params.organizationName,
            daysRemaining: params.daysRemaining,
            upgradeUrl: params.upgradeUrl,
        });

        await emailService.sendEmail({
            to: params.adminEmail,
            recipientName: params.adminName,
            recipientRole: 'admin',
            organizationId: params.organizationId,
            templateName: 'TRIAL_EXPIRING',
            subject: `Your NavixGo trial expires in ${params.daysRemaining} day(s)`,
            html,
            metadata: {
                organizationName: params.organizationName,
                daysRemaining: params.daysRemaining,
            },
        });
    },

    sendPaymentSuccessEmail: async (params: PaymentSuccessEmailParams): Promise<void> => {
        const html = paymentSuccessTemplate({
            adminName: params.adminName,
            planName: params.planName,
            busCount: params.busCount,
            amount: params.amount,
            currency: params.currency,
            expiryDate: params.expiryDate,
        });

        await emailService.sendEmail({
            to: params.adminEmail,
            recipientName: params.adminName,
            recipientRole: 'admin',
            organizationId: params.organizationId,
            templateName: 'PAYMENT_SUCCESS',
            subject: 'Payment Successful — NavixGo',
            html,
            metadata: {
                planName: params.planName,
                busCount: params.busCount,
                amount: params.amount,
                currency: params.currency,
            },
        });
    },

    sendPaymentFailedEmail: async (params: PaymentFailedEmailParams): Promise<void> => {
        const html = paymentFailedTemplate({
            adminName: params.adminName,
            planName: params.planName,
            reason: params.reason,
            retryUrl: params.retryUrl,
        });

        await emailService.sendEmail({
            to: params.adminEmail,
            recipientName: params.adminName,
            recipientRole: 'admin',
            organizationId: params.organizationId,
            templateName: 'PAYMENT_FAILED',
            subject: 'Payment Failed — NavixGo',
            html,
            metadata: {
                planName: params.planName,
                reason: params.reason,
            },
        });
    },

    sendPlanExpiredEmail: async (params: PlanExpiredEmailParams): Promise<void> => {
        const html = planExpiredTemplate({
            adminName: params.adminName,
            organizationName: params.organizationName,
            expiredPlanName: params.expiredPlanName,
            renewUrl: params.renewUrl,
        });

        await emailService.sendEmail({
            to: params.adminEmail,
            recipientName: params.adminName,
            recipientRole: 'admin',
            organizationId: params.organizationId,
            templateName: 'PLAN_EXPIRED',
            subject: 'Your NavixGo Plan Has Expired',
            html,
            metadata: {
                organizationName: params.organizationName,
                expiredPlanName: params.expiredPlanName,
            },
        });
    },

    // ──────────────────────────────────────────
    // Admin / query methods
    // ──────────────────────────────────────────

    getEmailLogs: async (organizationId: string, options: EmailLogQuery = {}) => {
        const page = options.page || 1;
        const limit = Math.min(options.limit || 20, 100);
        const skip = (page - 1) * limit;

        const filter: Record<string, unknown> = { organizationId };
        if (options.status) {
            filter.status = options.status;
        }

        const [logs, total] = await Promise.all([
            EmailLog.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            EmailLog.countDocuments(filter),
        ]);

        return {
            logs,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    },

    getEmailStats: async (organizationId: string) => {
        const [queued, sent, failed] = await Promise.all([
            EmailLog.countDocuments({ organizationId, status: 'queued' }),
            EmailLog.countDocuments({ organizationId, status: 'sent' }),
            EmailLog.countDocuments({ organizationId, status: 'failed' }),
        ]);

        return { queued, sent, failed, total: queued + sent + failed };
    },
};
