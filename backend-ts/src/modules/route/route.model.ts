import mongoose, { Document, Schema } from 'mongoose';

export interface IRoute extends Document {
    organizationId: mongoose.Types.ObjectId;
    name: string;
    startLat: number;
    startLng: number;
    endLat: number;
    endLng: number;
    version: number;
    polyline: string;
    encodedPolyline: string;
    polylineStopsHash: string;
    polylineGeneratedAt?: Date;
    polylineVersion: number;
    polylineRouteSignature: string;
    totalDistanceMeters: number;
    estimatedDurationSeconds: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const RouteSchema = new Schema<IRoute>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
        name: { type: String, required: true },
        startLat: { type: Number, required: true },
        startLng: { type: Number, required: true },
        endLat: { type: Number, required: true },
        endLng: { type: Number, required: true },
        version: { type: Number, default: 1 },
        polyline: { type: String, default: '' },
        encodedPolyline: { type: String, default: '' },
        polylineStopsHash: { type: String, default: '' },
        polylineGeneratedAt: { type: Date },
        polylineVersion: { type: Number, default: 0 },
        polylineRouteSignature: { type: String, default: '' },
        totalDistanceMeters: { type: Number },
        estimatedDurationSeconds: { type: Number },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

RouteSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export const Route = mongoose.model<IRoute>('Route', RouteSchema);
