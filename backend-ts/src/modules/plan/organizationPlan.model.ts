import mongoose, { Document, Schema } from 'mongoose';

export type OrganizationPlanStatus = 'active' | 'expired' | 'inactive';
export type PlanActivationSource = 'manual' | 'trial';

export interface IOrganizationPlanSubscription extends Document {
    organizationId: mongoose.Types.ObjectId;
    planCode: string;
    planName: string;
    description: string;
    durationDays: number;
    pricePerBus: number;
    busLimit: number;
    startsAt: Date;
    endsAt: Date;
    status: OrganizationPlanStatus;
    activationSource: PlanActivationSource;
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationPlanSubscriptionSchema = new Schema<IOrganizationPlanSubscription>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true, index: true },
        planCode: { type: String, required: true, index: true },
        planName: { type: String, required: true },
        description: { type: String, required: true },
        durationDays: { type: Number, required: true },
        pricePerBus: { type: Number, required: true },
        busLimit: { type: Number, required: true },
        startsAt: { type: Date, required: true },
        endsAt: { type: Date, required: true, index: true },
        status: { type: String, enum: ['active', 'expired', 'inactive'], default: 'inactive', index: true },
        activationSource: { type: String, enum: ['manual', 'trial'], default: 'manual' },
    },
    { timestamps: true }
);

OrganizationPlanSubscriptionSchema.index({ organizationId: 1, status: 1, endsAt: 1 });

export const OrganizationPlanSubscription = mongoose.model<IOrganizationPlanSubscription>(
    'OrganizationPlanSubscription',
    OrganizationPlanSubscriptionSchema
);
