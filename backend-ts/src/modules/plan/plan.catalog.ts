export type PlanCode = 'MONTHLY_1' | 'QUARTERLY_3' | 'SEMIANNUAL_6' | 'ANNUAL_12' | 'TRIAL_7D';

export interface PlanDefinition {
    code: PlanCode;
    name: string;
    description: string;
    durationDays: number;
    pricePerBus: number;
    isTrial: boolean;
    defaultBusLimit?: number;
}

export const PLAN_CATALOG: PlanDefinition[] = [
    {
        code: 'MONTHLY_1',
        name: 'Monthly per bus',
        description: '1 month access per bus',
        durationDays: 30,
        pricePerBus: 300,
        isTrial: false,
    },
    {
        code: 'QUARTERLY_3',
        name: '3 Months per bus',
        description: '3 month access per bus',
        durationDays: 90,
        pricePerBus: 750,
        isTrial: false,
    },
    {
        code: 'SEMIANNUAL_6',
        name: '6 Months per bus',
        description: '6 month access per bus',
        durationDays: 180,
        pricePerBus: 1500,
        isTrial: false,
    },
    {
        code: 'ANNUAL_12',
        name: '12 Months per bus',
        description: '12 month access per bus',
        durationDays: 365,
        pricePerBus: 2500,
        isTrial: false,
    },
    {
        code: 'TRIAL_7D',
        name: 'Free Trial',
        description: '7 day trial for up to 5 buses',
        durationDays: 7,
        pricePerBus: 0,
        isTrial: true,
        defaultBusLimit: 3,
    },
];

export const getPlanDefinition = (code: string): PlanDefinition | null => {
    const normalized = code.trim().toUpperCase();
    return PLAN_CATALOG.find((plan) => plan.code === normalized) || null;
};
