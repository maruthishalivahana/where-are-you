import mongoose, { Document, Schema } from 'mongoose';

export interface ILocationLog extends Document {
    organizationId: mongoose.Types.ObjectId;
    driverId: mongoose.Types.ObjectId;
    tripId: mongoose.Types.ObjectId;
    busId: mongoose.Types.ObjectId;
    latitude: number;
    longitude: number;
    location: {
        type: string;
        coordinates: [number, number]; // [longitude, latitude]
    };
    speed?: number;
    heading?: number;
    accuracy?: number;
    batteryLevel?: number;
    timestamp: Date;
    recordedAt: Date;
    createdAt: Date;
}

const LocationLogSchema = new Schema<ILocationLog>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
        driverId: { type: Schema.Types.ObjectId, ref: 'Driver', required: true, index: true },
        tripId: { type: Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
        busId: { type: Schema.Types.ObjectId, ref: 'Bus', required: true, index: true },
        latitude: { type: Number, required: true, min: -90, max: 90 },
        longitude: { type: Number, required: true, min: -180, max: 180 },
        location: {
            type: {
                type: String,
                enum: ['Point'],
                default: 'Point',
            },
            coordinates: {
                type: [Number],
                required: true,
            },
        },
        speed: { type: Number, min: 0 },
        heading: { type: Number, min: 0, max: 360 },
        accuracy: { type: Number, min: 0 },
        batteryLevel: { type: Number, min: 0, max: 100 },
        timestamp: { type: Date, required: true, index: true },
        recordedAt: { type: Date, default: Date.now },
        createdAt: { type: Date, default: Date.now, expire: 7776000 }, // 90-day TTL
    },
    { timestamps: false }
);

// Geospatial index for location queries
LocationLogSchema.index({ location: '2dsphere', timestamp: -1 });
// Compound indexes for common queries
LocationLogSchema.index({ organizationId: 1, driverId: 1, timestamp: -1 });
LocationLogSchema.index({ organizationId: 1, tripId: 1, timestamp: -1 });
LocationLogSchema.index({ organizationId: 1, busId: 1, timestamp: -1 });

export const LocationLog = mongoose.model<ILocationLog>('LocationLog', LocationLogSchema);
