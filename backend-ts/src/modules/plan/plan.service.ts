import { Bus } from '../bus/bus.model';
import { OrganizationPlanSubscription } from './organizationPlan.model';
import { getPlanDefinition, PLAN_CATALOG, PlanCode } from './plan.catalog';

const getNow = (): Date => new Date();

const getActiveOrganizationPlan = async (organizationId: string) => {
    const subscription = await OrganizationPlanSubscription.findOne({
        organizationId,
        status: 'active',
    }).sort({ endsAt: -1 });

    if (!subscription) {
        return null;
    }

    if (subscription.endsAt.getTime() <= getNow().getTime()) {
        subscription.status = 'expired';
        await subscription.save();
        return null;
    }

    return subscription;
};

const buildPlanResponse = (subscription: any, currentBusCount: number | null = null) => {
    if (!subscription) {
        return null;
    }

    return {
        id: String(subscription._id),
        organizationId: String(subscription.organizationId),
        planCode: subscription.planCode,
        planName: subscription.planName,
        description: subscription.description,
        durationDays: subscription.durationDays,
        pricePerBus: subscription.pricePerBus,
        busLimit: subscription.busLimit,
        startsAt: subscription.startsAt,
        endsAt: subscription.endsAt,
        status: subscription.status,
        activationSource: subscription.activationSource,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
        currentBusCount,
        remainingBusSlots: currentBusCount === null ? null : Math.max(0, subscription.busLimit - currentBusCount),
        isExpired: subscription.endsAt.getTime() <= getNow().getTime(),
    };
};

export const planService = {
    listPlans: async () => PLAN_CATALOG,

    getCurrentPlan: async (organizationId: string) => {
        const subscription = await getActiveOrganizationPlan(organizationId);
        if (!subscription) {
            return null;
        }

        const currentBusCount = await Bus.countDocuments({ organizationId });
        return buildPlanResponse(subscription, currentBusCount);
    },

    getPlanSummary: async (organizationId: string) => {
        const subscription = await getActiveOrganizationPlan(organizationId);
        const currentBusCount = await Bus.countDocuments({ organizationId });
        return {
            currentPlan: buildPlanResponse(subscription, currentBusCount),
            usage: {
                currentBusCount,
                hasActivePlan: Boolean(subscription),
                activePlanExpiresAt: subscription?.endsAt || null,
            },
        };
    },

    activatePlan: async (
        organizationId: string,
        input: { planCode: string; busCount?: number }
    ) => {
        const plan = getPlanDefinition(input.planCode);
        if (!plan) {
            throw new Error('Plan not found');
        }

        const busLimit = plan.isTrial ? (plan.defaultBusLimit || 5) : Number(input.busCount || 0);
        if (!Number.isInteger(busLimit) || busLimit <= 0) {
            throw new Error('busCount must be a positive integer');
        }

        const currentBusCount = await Bus.countDocuments({ organizationId });
        if (currentBusCount > busLimit) {
            throw new Error(`Selected plan allows only ${busLimit} buses, but ${currentBusCount} buses already exist`);
        }

        const now = getNow();
        const endsAt = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
        const subscription = await OrganizationPlanSubscription.findOneAndUpdate(
            { organizationId },
            {
                organizationId,
                planCode: plan.code,
                planName: plan.name,
                description: plan.description,
                durationDays: plan.durationDays,
                pricePerBus: plan.pricePerBus,
                busLimit,
                startsAt: now,
                endsAt,
                status: 'active',
                activationSource: plan.isTrial ? 'trial' : 'manual',
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return buildPlanResponse(subscription, currentBusCount);
    },

    requireActivePlan: async (organizationId: string) => {
        const subscription = await getActiveOrganizationPlan(organizationId);
        if (!subscription) {
            throw new Error('Active plan required. Please select a plan to continue.');
        }

        return subscription;
    },

    assertBusCapacity: async (organizationId: string) => {
        const subscription = await getActiveOrganizationPlan(organizationId);
        if (!subscription) {
            throw new Error('Active plan required. Please select a plan to continue.');
        }

        const currentBusCount = await Bus.countDocuments({ organizationId });
        if (currentBusCount >= subscription.busLimit) {
            throw new Error(
                `Your current plan allows only ${subscription.busLimit} buses. Upgrade your plan to add more buses.`
            );
        }

        return {
            subscription: buildPlanResponse(subscription, currentBusCount),
            currentBusCount,
        };
    },
};
