import mongoose, { Document, Schema } from 'mongoose';

export interface IBusSubscription extends Document {
    organizationId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    busId: mongoose.Types.ObjectId;
    stopId?: mongoose.Types.ObjectId | null;
    notifyOnBusStart: boolean;
    notifyOnNearStop: boolean;
    userLatitude?: number | null;
    userLongitude?: number | null;
    nearRadiusMeters: number;
    isActive: boolean;
    lastStartNotifiedAt?: Date | null;
    lastNearStopNotifiedAt?: Date | null;
    lastArrivedNotifiedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const BusSubscriptionSchema = new Schema<IBusSubscription>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        busId: { type: Schema.Types.ObjectId, ref: 'Bus', required: true },
        stopId: { type: Schema.Types.ObjectId, ref: 'Stop', default: null },
        notifyOnBusStart: { type: Boolean, default: true },
        notifyOnNearStop: { type: Boolean, default: true },
        userLatitude: { type: Number, default: null },
        userLongitude: { type: Number, default: null },
        nearRadiusMeters: { type: Number, default: 150 },
        isActive: { type: Boolean, default: true },
        lastStartNotifiedAt: { type: Date, default: null },
        lastNearStopNotifiedAt: { type: Date, default: null },
        lastArrivedNotifiedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

BusSubscriptionSchema.index({ organizationId: 1, userId: 1, busId: 1 }, { unique: true });

export const BusSubscription = mongoose.model<IBusSubscription>('BusSubscription', BusSubscriptionSchema);
