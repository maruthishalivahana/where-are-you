import axios from 'axios';
import crypto from 'crypto';
import { Payment } from './payment.model';
import { ENV } from '../../config/env.config';
import { getPlanDefinition } from '../plan/plan.catalog';
import { OrganizationPlanSubscription } from '../plan/organizationPlan.model';

const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

const getAuthHeader = (): string => {
    const keyId = ENV.RAZORPAY_KEY_ID || '';
    const keySecret = ENV.RAZORPAY_KEY_SECRET || '';
    const token = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    return `Basic ${token}`;
};

const assertRazorpayConfigured = () => {
    if (!ENV.RAZORPAY_KEY_ID || !ENV.RAZORPAY_KEY_SECRET) {
        throw new Error('Razorpay keys are not configured');
    }
};

const computeSignature = (orderId: string, paymentId: string): string => {
    return crypto
        .createHmac('sha256', ENV.RAZORPAY_KEY_SECRET || '')
        .update(`${orderId}|${paymentId}`)
        .digest('hex');
};

const timingSafeEqual = (a: string, b: string): boolean => {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
};

export const paymentService = {
    createRazorpayOrder: async (params: {
        organizationId: string;
        planCode: string;
        busCount: number;
    }) => {
        const plan = getPlanDefinition(params.planCode);
        if (!plan) {
            throw new Error('Plan not found');
        }

        if (plan.isTrial) {
            throw new Error('Trial does not require payment. Activate trial directly.');
        }

        if (!Number.isInteger(params.busCount) || params.busCount <= 0) {
            throw new Error('busCount must be a positive integer');
        }

        assertRazorpayConfigured();

        const amount = plan.pricePerBus * params.busCount * 100;
        const receipt = `org_${params.organizationId.toString().slice(-6)}_${Date.now()}`;

        let response;
        try {
            response = await axios.post(
                RAZORPAY_ORDERS_URL,
                {
                    amount,
                    currency: 'INR',
                    receipt,
                    notes: {
                        organizationId: params.organizationId,
                        planCode: plan.code,
                        busCount: params.busCount,
                    },
                },
                {
                    headers: {
                        Authorization: getAuthHeader(),
                    },
                }
            );
        } catch (error) {
            if (axios.isAxiosError(error)) {
                const data = error.response?.data as { error?: { description?: string } } | undefined;
                const message = data?.error?.description || error.message;
                throw new Error(`Razorpay order creation failed: ${message}`);
            }

            throw error;
        }

        const order = response.data as { id: string; amount: number; currency: string; receipt?: string };

        const payment = await Payment.create({
            organizationId: params.organizationId,
            planCode: plan.code,
            busCount: params.busCount,
            amount: order.amount,
            currency: order.currency,
            status: 'created',
            provider: 'razorpay',
            orderId: order.id,
            receipt: order.receipt || receipt,
            notes: {
                planCode: plan.code,
                busCount: params.busCount,
            },
        });

        return {
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            receipt: order.receipt || receipt,
            planCode: plan.code,
            busCount: params.busCount,
            paymentId: String(payment._id),
        };
    },

    verifyRazorpayPayment: async (params: {
        organizationId: string;
        orderId: string;
        paymentId: string;
        signature: string;
    }) => {
        if (!params.orderId || !params.paymentId || !params.signature) {
            throw new Error('orderId, paymentId, and signature are required');
        }

        assertRazorpayConfigured();

        const expectedSignature = computeSignature(params.orderId, params.paymentId);
        if (!timingSafeEqual(expectedSignature, params.signature)) {
            throw new Error('Invalid payment signature');
        }

        const payment = await Payment.findOne({ orderId: params.orderId, organizationId: params.organizationId });
        if (!payment) {
            throw new Error('Payment record not found');
        }

        if (payment.status === 'paid') {
            return payment;
        }

        payment.status = 'paid';
        payment.paymentId = params.paymentId;
        payment.signature = params.signature;
        payment.paidAt = new Date();
        await payment.save();

        return payment;
    },

    getPaymentStatus: async (params: { organizationId: string; orderId: string }) => {
        const payment = await Payment.findOne({ orderId: params.orderId, organizationId: params.organizationId });
        if (!payment) {
            throw new Error('Payment record not found');
        }

        return payment;
    },

    markPaymentPaidByOrder: async (params: { orderId: string; paymentId?: string; signature?: string }) => {
        const payment = await Payment.findOne({ orderId: params.orderId });
        if (!payment) {
            return null;
        }

        if (payment.status === 'paid') {
            return payment;
        }

        payment.status = 'paid';
        if (params.paymentId) {
            payment.paymentId = params.paymentId;
        }
        if (params.signature) {
            payment.signature = params.signature;
        }
        payment.paidAt = new Date();
        await payment.save();

        return payment;
    },

    markPaymentFailed: async (orderId: string, reason?: string) => {
        const payment = await Payment.findOne({ orderId });
        if (!payment) {
            return null;
        }

        payment.status = 'failed';
        payment.notes = { ...(payment.notes || {}), failureReason: reason };
        await payment.save();

        const subscriptionDocument = await OrganizationPlanSubscription.findOne({ organizationId: payment.organizationId });
        if (subscriptionDocument) {
            const historyRecord = (subscriptionDocument.paymentHistory || []).find(
                (record: any) => record.orderId === orderId
            );

            if (historyRecord) {
                historyRecord.status = 'failed';
                historyRecord.failureReason = reason;
                historyRecord.paymentId = payment.paymentId || historyRecord.paymentId;
                await subscriptionDocument.save();
            } else {
                subscriptionDocument.paymentHistory.push({
                    orderId,
                    paymentId: payment.paymentId,
                    planCode: payment.planCode,
                    planName: payment.planCode,
                    busCount: payment.busCount,
                    amount: payment.amount,
                    currency: payment.currency,
                    status: 'failed',
                    failureReason: reason,
                } as any);
                await subscriptionDocument.save();
            }
        }

        return payment;
    },

    verifyWebhookSignature: (rawBody: Buffer, signature: string): boolean => {
        if (!ENV.RAZORPAY_WEBHOOK_SECRET) {
            throw new Error('Razorpay webhook secret is not configured');
        }

        const expected = crypto
            .createHmac('sha256', ENV.RAZORPAY_WEBHOOK_SECRET)
            .update(rawBody)
            .digest('hex');

        return timingSafeEqual(expected, signature);
    },
};
