import mongoose, { Document, Schema } from 'mongoose';

export type OrganizationPlanStatus = 'active' | 'expired' | 'inactive';
export type PlanActivationSource = 'manual' | 'trial' | 'payment';
export type OrganizationPlanRecordStatus = 'active' | 'expired' | 'cancelled';
export type OrganizationPlanPaymentStatus = 'created' | 'paid' | 'failed';

export interface IOrganizationPlanRecord {
    planCode: string;
    planName: string;
    description: string;
    durationDays: number;
    pricePerBus: number;
    busLimit: number;
    startsAt: Date;
    endsAt: Date;
    status: OrganizationPlanRecordStatus;
    activationSource: PlanActivationSource;
    paymentOrderId?: string;
    paymentId?: string;
    paymentAmount?: number;
    paymentCurrency?: string;
}

export interface IOrganizationPaymentHistoryItem {
    orderId: string;
    paymentId?: string;
    planCode: string;
    planName: string;
    busCount: number;
    amount: number;
    currency: string;
    status: OrganizationPlanPaymentStatus;
    receipt?: string;
    failureReason?: string;
    createdAt?: Date;
    updatedAt?: Date;
    paidAt?: Date;
}

export interface IOrganizationPlanSubscription extends Document {
    organizationId: mongoose.Types.ObjectId;
    currentPlanCode?: string | null;
    currentPlanName?: string | null;
    currentPlanEndsAt?: Date | null;
    currentPlanStatus?: OrganizationPlanStatus | null;
    currentPlanActivationSource?: PlanActivationSource | null;
    activePlans: IOrganizationPlanRecord[];
    paymentHistory: IOrganizationPaymentHistoryItem[];
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationPlanRecordSchema = new Schema<IOrganizationPlanRecord>(
    {
        planCode: { type: String, required: true, index: true },
        planName: { type: String, required: true },
        description: { type: String, required: true },
        durationDays: { type: Number, required: true },
        pricePerBus: { type: Number, required: true },
        busLimit: { type: Number, required: true },
        startsAt: { type: Date, required: true },
        endsAt: { type: Date, required: true, index: true },
        status: { type: String, enum: ['active', 'expired', 'cancelled'], default: 'active', index: true },
        activationSource: { type: String, enum: ['manual', 'trial', 'payment'], default: 'manual' },
        paymentOrderId: { type: String },
        paymentId: { type: String },
        paymentAmount: { type: Number },
        paymentCurrency: { type: String },
    },
    { _id: true }
);

const OrganizationPaymentHistorySchema = new Schema<IOrganizationPaymentHistoryItem>(
    {
        orderId: { type: String, required: true, index: true },
        paymentId: { type: String },
        planCode: { type: String, required: true, index: true },
        planName: { type: String, required: true },
        busCount: { type: Number, required: true },
        amount: { type: Number, required: true },
        currency: { type: String, required: true },
        status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created', index: true },
        receipt: { type: String },
        failureReason: { type: String },
        paidAt: { type: Date },
    },
    { timestamps: true, _id: true }
);

const OrganizationPlanSubscriptionSchema = new Schema<IOrganizationPlanSubscription>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true, index: true },
        currentPlanCode: { type: String, default: null },
        currentPlanName: { type: String, default: null },
        currentPlanEndsAt: { type: Date, default: null },
        currentPlanStatus: { type: String, enum: ['active', 'expired', 'inactive'], default: 'inactive' },
        currentPlanActivationSource: { type: String, enum: ['manual', 'trial', 'payment'], default: 'manual' },
        activePlans: { type: [OrganizationPlanRecordSchema], default: [] },
        paymentHistory: { type: [OrganizationPaymentHistorySchema], default: [] },
    },
    { timestamps: true }
);

OrganizationPlanSubscriptionSchema.index({ organizationId: 1, currentPlanStatus: 1, currentPlanEndsAt: 1 });

export const OrganizationPlanSubscription = mongoose.model<IOrganizationPlanSubscription>(
    'OrganizationPlanSubscription',
    OrganizationPlanSubscriptionSchema
);
