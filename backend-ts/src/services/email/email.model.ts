import mongoose, { Document, Schema } from 'mongoose';

// ──────────────────────────────────────────────
// EmailLog — tracks every email sent through the system
// ──────────────────────────────────────────────

export type EmailStatus = 'queued' | 'sent' | 'failed' | 'bounced';
export type RecipientRole = 'admin' | 'user' | 'driver' | 'system';

export interface IEmailLog extends Document {
    organizationId?: mongoose.Types.ObjectId | null;
    recipientEmail: string;
    recipientName?: string;
    recipientRole: RecipientRole;
    recipientId?: mongoose.Types.ObjectId | null;
    templateName: string;
    subject: string;
    status: EmailStatus;
    resendMessageId?: string | null;
    errorMessage?: string | null;
    retryCount: number;
    metadata?: Record<string, unknown>;
    sentAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const EmailLogSchema = new Schema<IEmailLog>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
        recipientEmail: { type: String, required: true, index: true },
        recipientName: { type: String, default: null },
        recipientRole: {
            type: String,
            enum: ['admin', 'user', 'driver', 'system'],
            default: 'admin',
        },
        recipientId: { type: Schema.Types.ObjectId, default: null },
        templateName: { type: String, required: true, index: true },
        subject: { type: String, required: true },
        status: {
            type: String,
            enum: ['queued', 'sent', 'failed', 'bounced'],
            default: 'queued',
            index: true,
        },
        resendMessageId: { type: String, default: null },
        errorMessage: { type: String, default: null },
        retryCount: { type: Number, default: 0 },
        metadata: { type: Schema.Types.Mixed, default: {} },
        sentAt: { type: Date, default: null },
    },
    { timestamps: true }
);

EmailLogSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
EmailLogSchema.index({ templateName: 1, createdAt: -1 });

export const EmailLog = mongoose.model<IEmailLog>('EmailLog', EmailLogSchema);

// ──────────────────────────────────────────────
// EmailPreference — per-user email opt-in/out
// ──────────────────────────────────────────────

export interface IEmailPreference extends Document {
    userId: mongoose.Types.ObjectId;
    organizationId: mongoose.Types.ObjectId;
    welcomeEmail: boolean;
    tripAlerts: boolean;
    paymentReceipts: boolean;
    planExpiryReminders: boolean;
    adminDigest: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const EmailPreferenceSchema = new Schema<IEmailPreference>(
    {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
        welcomeEmail: { type: Boolean, default: true },
        tripAlerts: { type: Boolean, default: true },
        paymentReceipts: { type: Boolean, default: true },
        planExpiryReminders: { type: Boolean, default: true },
        adminDigest: { type: Boolean, default: true },
    },
    { timestamps: true }
);

export const EmailPreference = mongoose.model<IEmailPreference>('EmailPreference', EmailPreferenceSchema);
