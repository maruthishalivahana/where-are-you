import { Request, Response } from 'express';
import { paymentService } from './payment.service';
import { planService } from '../plan/plan.service';
import { logger } from '../../utils/logger';
import { ENV } from '../../config/env.config';

const getMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Something went wrong';

export const paymentController = {
    createRazorpayOrder: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const planCode = String(req.body?.planCode || '').trim();
            const busCountRaw = req.body?.busCount;
            const busCount =
                typeof busCountRaw === 'number'
                    ? busCountRaw
                    : typeof busCountRaw === 'string' && busCountRaw.trim().length > 0
                        ? Number(busCountRaw)
                        : undefined;

            if (!planCode) {
                res.status(400).json({ message: 'planCode is required' });
                return;
            }

            if (!busCount) {
                res.status(400).json({ message: 'busCount is required for paid plans' });
                return;
            }

            const order = await paymentService.createRazorpayOrder({
                organizationId: req.user.organizationId,
                planCode,
                busCount,
            });

            res.status(200).json({ order, keyId: ENV.RAZORPAY_KEY_ID });
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    verifyRazorpayPayment: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const orderId = String(req.body?.orderId || '').trim();
            const paymentId = String(req.body?.paymentId || '').trim();
            const signature = String(req.body?.signature || '').trim();

            if (!orderId || !paymentId || !signature) {
                res.status(400).json({ message: 'orderId, paymentId, and signature are required' });
                return;
            }

            const payment = await paymentService.verifyRazorpayPayment({
                organizationId: req.user.organizationId,
                orderId,
                paymentId,
                signature,
            });

            const currentPlan = await planService.activatePaidPlan(req.user.organizationId, {
                planCode: payment.planCode,
                busCount: payment.busCount,
                orderId: payment.orderId,
                paymentId: payment.paymentId || paymentId,
                amount: payment.amount,
                currency: payment.currency,
                activationSource: 'manual',
            });

            res.status(200).json({ currentPlan });
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    getRazorpayStatus: async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user?.organizationId) {
                res.status(401).json({ message: 'Unauthorized' });
                return;
            }

            const orderId = String(req.query?.orderId || '').trim();
            if (!orderId) {
                res.status(400).json({ message: 'orderId is required' });
                return;
            }

            const payment = await paymentService.getPaymentStatus({
                organizationId: req.user.organizationId,
                orderId,
            });

            res.status(200).json({
                payment: {
                    orderId: payment.orderId,
                    status: payment.status,
                    planCode: payment.planCode,
                    busCount: payment.busCount,
                    amount: payment.amount,
                    currency: payment.currency,
                    paymentId: payment.paymentId || null,
                    paidAt: payment.paidAt || null,
                    createdAt: payment.createdAt,
                },
            });
        } catch (error) {
            res.status(400).json({ message: getMessage(error) });
        }
    },

    razorpayWebhook: async (req: Request, res: Response): Promise<void> => {
        try {
            const signature = String(req.headers['x-razorpay-signature'] || '').trim();
            const rawBody = (req as any).rawBody as Buffer | undefined;

            if (!rawBody || !signature) {
                res.status(400).json({ message: 'Invalid webhook payload' });
                return;
            }

            if (!paymentService.verifyWebhookSignature(rawBody, signature)) {
                res.status(400).json({ message: 'Invalid webhook signature' });
                return;
            }

            const event = String(req.body?.event || '');
            const paymentEntity = req.body?.payload?.payment?.entity;
            const orderId = paymentEntity?.order_id;
            const paymentId = paymentEntity?.id;

            if (!orderId || !paymentId) {
                res.status(200).json({ status: 'ignored' });
                return;
            }

            if (event === 'payment.failed') {
                await paymentService.markPaymentFailed(orderId, paymentEntity?.error_description || 'payment_failed');
                res.status(200).json({ status: 'failed_recorded' });
                return;
            }

            if (event !== 'payment.captured' && event !== 'order.paid') {
                res.status(200).json({ status: 'ignored' });
                return;
            }

            const payment = await paymentService.markPaymentPaidByOrder({
                orderId,
                paymentId,
                signature: paymentEntity?.signature || req.body?.payload?.payment?.entity?.signature || undefined,
            });

            if (!payment) {
                res.status(200).json({ status: 'no_payment_record' });
                return;
            }

            await planService.activatePaidPlan(String(payment.organizationId), {
                planCode: payment.planCode,
                busCount: payment.busCount,
                orderId: payment.orderId,
                paymentId: payment.paymentId || paymentId,
                amount: payment.amount,
                currency: payment.currency,
                activationSource: 'payment',
            });

            res.status(200).json({ status: 'ok' });
        } catch (error) {
            logger.warn('[RazorpayWebhook] processing failed', error);
            res.status(200).json({ status: 'ignored' });
        }
    },
};
