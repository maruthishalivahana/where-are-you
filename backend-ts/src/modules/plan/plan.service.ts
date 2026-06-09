import { Bus } from '../bus/bus.model';
import { Payment } from '../payment/payment.model';
import { OrganizationPlanSubscription } from './organizationPlan.model';
import { getPlanDefinition, PLAN_CATALOG } from './plan.catalog';

const getNow = (): Date => new Date();

const getOrCreatePlanDocument = async (organizationId: string) => {
    return OrganizationPlanSubscription.findOneAndUpdate(
        { organizationId },
        {
            $setOnInsert: {
                organizationId,
                activePlans: [],
                paymentHistory: [],
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const formatPlanRecord = (record: any, now: Date) => {
    const startsAt = new Date(record.startsAt);
    const endsAt = new Date(record.endsAt);
    const isExpired = endsAt.getTime() <= now.getTime();
    const status = isExpired && record.status === 'active' ? 'expired' : record.status;

    return {
        id: String(record._id),
        planCode: record.planCode,
        planName: record.planName,
        description: record.description,
        durationDays: record.durationDays,
        pricePerBus: record.pricePerBus,
        busLimit: record.busLimit,
        startsAt,
        endsAt,
        status,
        activationSource: record.activationSource,
        paymentOrderId: record.paymentOrderId || null,
        paymentId: record.paymentId || null,
        paymentAmount: record.paymentAmount ?? null,
        paymentCurrency: record.paymentCurrency || null,
        isExpired,
    };
};

const formatPaymentHistoryRecord = (record: any) => ({
    id: String(record._id),
    orderId: record.orderId,
    paymentId: record.paymentId || null,
    planCode: record.planCode,
    planName: record.planName,
    busCount: record.busCount,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    receipt: record.receipt || null,
    failureReason: record.failureReason || null,
    paidAt: record.paidAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
});

const refreshExpiredPlans = async (subscriptionDocument: any) => {
    if (!subscriptionDocument) {
        return false;
    }

    const now = getNow();
    let changed = false;

    for (const planRecord of subscriptionDocument.activePlans || []) {
        if (planRecord.status === 'active' && new Date(planRecord.endsAt).getTime() <= now.getTime()) {
            planRecord.status = 'expired';
            changed = true;
        }
    }

    if (changed) {
        const latestActive = [...(subscriptionDocument.activePlans || [])]
            .filter((planRecord) => planRecord.status === 'active')
            .sort((left, right) => new Date(right.endsAt).getTime() - new Date(left.endsAt).getTime())[0];

        subscriptionDocument.currentPlanCode = latestActive?.planCode || null;
        subscriptionDocument.currentPlanName = latestActive?.planName || null;
        subscriptionDocument.currentPlanEndsAt = latestActive?.endsAt || null;
        subscriptionDocument.currentPlanStatus = latestActive ? 'active' : 'inactive';
        subscriptionDocument.currentPlanActivationSource = latestActive?.activationSource || null;
        await subscriptionDocument.save();
    }

    return changed;
};

const buildPlanResponse = (subscriptionDocument: any, currentBusCount: number | null = null) => {
    if (!subscriptionDocument) {
        return null;
    }

    const now = getNow();
    const activePlans = (subscriptionDocument.activePlans || [])
        .map((record: any) => formatPlanRecord(record, now))
        .filter((record: any) => record.status === 'active' && !record.isExpired)
        .sort((left: any, right: any) => new Date(right.endsAt).getTime() - new Date(left.endsAt).getTime());

    const totalActiveBusLimit = activePlans.reduce((total: number, record: any) => total + Number(record.busLimit || 0), 0);
    const latestActivePlan = activePlans[0] || null;
    const paymentHistory = (subscriptionDocument.paymentHistory || [])
        .map((record: any) => formatPaymentHistoryRecord(record))
        .sort((left: any, right: any) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    return {
        id: String(subscriptionDocument._id),
        organizationId: String(subscriptionDocument.organizationId),
        currentPlan: latestActivePlan,
        currentPlanCode: latestActivePlan?.planCode || null,
        currentPlanName: latestActivePlan?.planName || null,
        currentPlanEndsAt: latestActivePlan?.endsAt || null,
        currentPlanStatus: latestActivePlan?.status || 'inactive',
        currentPlanActivationSource: latestActivePlan?.activationSource || null,
        activePlans,
        paymentHistory,
        totalActiveBusLimit,
        busLimit: totalActiveBusLimit,
        currentBusCount,
        remainingBusSlots: currentBusCount === null ? null : Math.max(0, totalActiveBusLimit - currentBusCount),
        hasActivePlan: activePlans.length > 0,
        activePlanCount: activePlans.length,
        paymentHistoryCount: paymentHistory.length,
        isExpired: latestActivePlan ? latestActivePlan.isExpired : true,
        createdAt: subscriptionDocument.createdAt,
        updatedAt: subscriptionDocument.updatedAt,
    };
};

const getCurrentPlanDocument = async (organizationId: string) => {
    const subscriptionDocument = await OrganizationPlanSubscription.findOne({ organizationId });
    if (!subscriptionDocument) {
        return null;
    }

    await refreshExpiredPlans(subscriptionDocument);
    return subscriptionDocument;
};

const getTotalActiveBusLimit = (subscriptionDocument: any) => {
    const now = getNow();
    return (subscriptionDocument?.activePlans || [])
        .map((record: any) => formatPlanRecord(record, now))
        .filter((record: any) => record.status === 'active' && !record.isExpired)
        .reduce((total: number, record: any) => total + Number(record.busLimit || 0), 0);
};

export const planService = {
    listPlans: async (organizationId?: string) => {
        if (!organizationId) {
            return PLAN_CATALOG;
        }

        // Check if free trial was ever used by this organization
        const subscriptionDocument = await OrganizationPlanSubscription.findOne({ organizationId });
        const hasUsedTrial = (subscriptionDocument?.activePlans || []).some(
            (record: any) => record.activationSource === 'trial'
        );

        if (hasUsedTrial) {
            return PLAN_CATALOG.filter((plan) => !plan.isTrial);
        }

        return PLAN_CATALOG;
    },

    getCurrentPlan: async (organizationId: string) => {
        const subscriptionDocument = await getCurrentPlanDocument(organizationId);
        if (!subscriptionDocument) {
            return null;
        }

        const currentBusCount = await Bus.countDocuments({ organizationId });
        const planResponse = buildPlanResponse(subscriptionDocument, currentBusCount);
        if (!planResponse?.hasActivePlan) {
            return null;
        }

        return planResponse;
    },

    getPlanSummary: async (organizationId: string) => {
        const subscriptionDocument = await getCurrentPlanDocument(organizationId);
        const currentBusCount = await Bus.countDocuments({ organizationId });

        if (!subscriptionDocument) {
            return {
                currentPlan: null,
                activePlans: [],
                paymentHistory: [],
                usage: {
                    currentBusCount,
                    totalActiveBusLimit: 0,
                    remainingBusSlots: 0,
                    hasActivePlan: false,
                    activePlanExpiresAt: null,
                    activePlanCount: 0,
                },
            };
        }

        const summary = buildPlanResponse(subscriptionDocument, currentBusCount);
        if (!summary) {
            return {
                currentPlan: null,
                activePlans: [],
                paymentHistory: [],
                usage: {
                    currentBusCount,
                    totalActiveBusLimit: 0,
                    remainingBusSlots: 0,
                    hasActivePlan: false,
                    activePlanExpiresAt: null,
                    activePlanCount: 0,
                },
            };
        }

        return {
            currentPlan: summary.currentPlan,
            activePlans: summary.activePlans,
            paymentHistory: summary.paymentHistory,
            usage: {
                currentBusCount,
                totalActiveBusLimit: summary.totalActiveBusLimit,
                remainingBusSlots: summary.remainingBusSlots,
                hasActivePlan: summary.hasActivePlan,
                activePlanExpiresAt: summary.currentPlanEndsAt || null,
                activePlanCount: summary.activePlanCount,
            },
        };
    },

    getCapacityInfo: async (organizationId: string) => {
        const subscriptionDocument = await getCurrentPlanDocument(organizationId);
        const currentBusCount = await Bus.countDocuments({ organizationId });

        if (!subscriptionDocument) {
            return {
                currentBusCount,
                totalActiveBusLimit: 0,
                remainingBusSlots: 0,
                hasActivePlan: false,
                activePlans: [],
                needMoreBuses: true,
                activePlanCount: 0,
            };
        }

        const totalActiveBusLimit = getTotalActiveBusLimit(subscriptionDocument);
        const activePlans = buildPlanResponse(subscriptionDocument, currentBusCount)?.activePlans || [];

        return {
            currentBusCount,
            totalActiveBusLimit,
            remainingBusSlots: Math.max(0, totalActiveBusLimit - currentBusCount),
            hasActivePlan: totalActiveBusLimit > 0,
            activePlans,
            needMoreBuses: currentBusCount >= totalActiveBusLimit,
            activePlanCount: activePlans.length,
        };
    },

    getPaymentHistory: async (organizationId: string) => {
        const payments = await Payment.find({ organizationId }).sort({ createdAt: -1 });

        return payments.map((payment) => ({
            id: String(payment._id),
            orderId: payment.orderId,
            paymentId: payment.paymentId || null,
            planCode: payment.planCode,
            busCount: payment.busCount,
            amount: payment.amount,
            currency: payment.currency,
            status: payment.status,
            receipt: payment.receipt || null,
            failureReason: (payment.notes as any)?.failureReason || null,
            paidAt: payment.paidAt || null,
            createdAt: payment.createdAt,
            updatedAt: payment.updatedAt,
        }));
    },

    activatePlan: async (organizationId: string, input: { planCode: string }) => {
        const plan = getPlanDefinition(input.planCode);
        if (!plan) {
            throw new Error('Plan not found');
        }

        if (!plan.isTrial) {
            throw new Error('Paid plans require verified payment before activation');
        }

        const busLimit = plan.defaultBusLimit || 5;
        const subscriptionDocument = await getOrCreatePlanDocument(organizationId);
        await refreshExpiredPlans(subscriptionDocument);

        // Prevent re-activation of free trial
        const hasUsedTrial = (subscriptionDocument.activePlans || []).some(
            (record: any) => record.activationSource === 'trial'
        );
        if (hasUsedTrial) {
            throw new Error('Free trial has already been used for this organization. Please choose a paid plan.');
        }

        const currentBusCount = await Bus.countDocuments({ organizationId });
        const totalActiveBusLimit = getTotalActiveBusLimit(subscriptionDocument);

        if (currentBusCount > totalActiveBusLimit + busLimit) {
            throw new Error(
                `Selected plan allows only ${busLimit} buses, but you already have ${currentBusCount} buses. Buy more buses to continue.`
            );
        }

        const now = getNow();
        const endsAt = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

        subscriptionDocument.activePlans.push({
            planCode: plan.code,
            planName: plan.name,
            description: plan.description,
            durationDays: plan.durationDays,
            pricePerBus: plan.pricePerBus,
            busLimit,
            startsAt: now,
            endsAt,
            status: 'active',
            activationSource: 'trial',
        });

        subscriptionDocument.currentPlanCode = plan.code;
        subscriptionDocument.currentPlanName = plan.name;
        subscriptionDocument.currentPlanEndsAt = endsAt;
        subscriptionDocument.currentPlanStatus = 'active';
        subscriptionDocument.currentPlanActivationSource = 'trial';

        await subscriptionDocument.save();

        return buildPlanResponse(subscriptionDocument, currentBusCount);
    },

    activatePaidPlan: async (
        organizationId: string,
        input: {
            planCode: string;
            busCount: number;
            orderId: string;
            paymentId: string;
            amount: number;
            currency: string;
            activationSource?: 'payment' | 'manual';
        }
    ) => {
        const plan = getPlanDefinition(input.planCode);
        if (!plan) {
            throw new Error('Plan not found');
        }

        if (plan.isTrial) {
            throw new Error('Trial plan cannot be activated via payment');
        }

        const busLimit = Number(input.busCount || 0);
        if (!Number.isInteger(busLimit) || busLimit <= 0) {
            throw new Error('busCount must be a positive integer');
        }

        const expectedAmount = plan.pricePerBus * busLimit * 100;
        if (expectedAmount !== input.amount) {
            throw new Error('Payment amount does not match the selected plan');
        }

        const subscriptionDocument = await getOrCreatePlanDocument(organizationId);
        await refreshExpiredPlans(subscriptionDocument);

        const currentBusCount = await Bus.countDocuments({ organizationId });
        const totalActiveBusLimit = getTotalActiveBusLimit(subscriptionDocument);

        if (currentBusCount > totalActiveBusLimit + busLimit) {
            throw new Error(
                `Selected plan allows only ${busLimit} buses, but you already have ${currentBusCount} buses. Buy more buses to continue.`
            );
        }

        const now = getNow();
        const endsAt = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

        const existingActivePlan = (subscriptionDocument.activePlans || []).find(
            (record: any) => record.paymentOrderId === input.orderId && record.status === 'active'
        );

        if (!existingActivePlan) {
            subscriptionDocument.activePlans.push({
                planCode: plan.code,
                planName: plan.name,
                description: plan.description,
                durationDays: plan.durationDays,
                pricePerBus: plan.pricePerBus,
                busLimit,
                startsAt: now,
                endsAt,
                status: 'active',
                activationSource: input.activationSource || 'payment',
                paymentOrderId: input.orderId,
                paymentId: input.paymentId,
                paymentAmount: input.amount,
                paymentCurrency: input.currency,
            });
        }

        const existingHistory = (subscriptionDocument.paymentHistory || []).find(
            (record: any) => record.orderId === input.orderId
        );

        if (existingHistory) {
            existingHistory.paymentId = input.paymentId;
            existingHistory.status = 'paid';
            existingHistory.failureReason = undefined;
            existingHistory.paidAt = now;
            existingHistory.amount = input.amount;
            existingHistory.currency = input.currency;
            existingHistory.busCount = busLimit;
            existingHistory.planCode = plan.code;
            existingHistory.planName = plan.name;
        } else {
            subscriptionDocument.paymentHistory.push({
                orderId: input.orderId,
                paymentId: input.paymentId,
                planCode: plan.code,
                planName: plan.name,
                busCount: busLimit,
                amount: input.amount,
                currency: input.currency,
                status: 'paid',
                paidAt: now,
            });
        }

        subscriptionDocument.currentPlanCode = plan.code;
        subscriptionDocument.currentPlanName = plan.name;
        subscriptionDocument.currentPlanEndsAt = endsAt;
        subscriptionDocument.currentPlanStatus = 'active';
        subscriptionDocument.currentPlanActivationSource = input.activationSource || 'payment';

        await subscriptionDocument.save();

        return buildPlanResponse(subscriptionDocument, currentBusCount);
    },

    requireActivePlan: async (organizationId: string) => {
        const subscriptionDocument = await getCurrentPlanDocument(organizationId);
        if (!subscriptionDocument) {
            throw new Error('Active plan required. Please select a plan to continue.');
        }

        const activePlans = (buildPlanResponse(subscriptionDocument, null)?.activePlans || []) as any[];
        if (activePlans.length === 0) {
            throw new Error('Active plan required. Please select a plan to continue.');
        }

        return subscriptionDocument;
    },

    assertBusCapacity: async (organizationId: string) => {
        const subscriptionDocument = await getCurrentPlanDocument(organizationId);
        if (!subscriptionDocument) {
            throw new Error('Active plan required. Please select a plan to continue.');
        }

        const currentBusCount = await Bus.countDocuments({ organizationId });
        const totalActiveBusLimit = getTotalActiveBusLimit(subscriptionDocument);

        if (totalActiveBusLimit <= 0) {
            throw new Error('Active plan required. Please select a plan to continue.');
        }

        if (currentBusCount >= totalActiveBusLimit) {
            throw new Error(
                `Your current active plans allow only ${totalActiveBusLimit} buses. You already have ${currentBusCount} buses. Buy more buses to continue.`
            );
        }

        return {
            subscription: buildPlanResponse(subscriptionDocument, currentBusCount),
            currentBusCount,
            totalActiveBusLimit,
            remainingBusSlots: Math.max(0, totalActiveBusLimit - currentBusCount),
        };
    },
};
