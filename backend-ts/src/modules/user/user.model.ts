import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
    organizationId: mongoose.Types.ObjectId;
    name: string;
    memberId: string;    // unique per org, e.g. student ID or employee ID
    routeId?: mongoose.Types.ObjectId | null;
    email?: string;
    phone?: string;
    passwordHash: string;
    fcmToken: string;
    createdAt: Date;
}

const UserSchema = new Schema<IUser>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
        name: { type: String, required: true },
        memberId: { type: String, required: true },
        routeId: { type: Schema.Types.ObjectId, ref: 'Route' },
        email: { type: String, trim: true, lowercase: true },
        phone: { type: String, trim: true },
        passwordHash: { type: String, required: true },
        fcmToken: { type: String },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

UserSchema.index({ organizationId: 1, memberId: 1 }, { unique: true });
UserSchema.index({ organizationId: 1, email: 1 }, { unique: true, sparse: true });
UserSchema.index({ organizationId: 1, phone: 1 }, { unique: true, sparse: true });

export const User = mongoose.model<IUser>('User', UserSchema);
