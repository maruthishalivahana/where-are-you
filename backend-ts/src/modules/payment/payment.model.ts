import mongoose, { Document, Schema } from 'mongoose';

export type PaymentStatus = 'created' | 'paid' | 'failed';

export interface IPayment extends Document {
    organizationId: mongoose.Types.ObjectId;
    planCode: string;
    busCount: number;
    amount: number;
    currency: string;
    status: PaymentStatus;
    provider: 'razorpay';
    orderId: string;
    paymentId?: string;
    signature?: string;
    receipt?: string;
    notes?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
    paidAt?: Date;
}

const PaymentSchema = new Schema<IPayment>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
        planCode: { type: String, required: true, index: true },
        busCount: { type: Number, required: true },
        amount: { type: Number, required: true },
        currency: { type: String, required: true },
        status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created', index: true },
        provider: { type: String, enum: ['razorpay'], default: 'razorpay' },
        orderId: { type: String, required: true, unique: true, index: true },
        paymentId: { type: String },
        signature: { type: String },
        receipt: { type: String },
        notes: { type: Schema.Types.Mixed },
        paidAt: { type: Date },
    },
    { timestamps: true }
);

PaymentSchema.index({ organizationId: 1, createdAt: -1 });

export const Payment = mongoose.model<IPayment>('Payment', PaymentSchema);
