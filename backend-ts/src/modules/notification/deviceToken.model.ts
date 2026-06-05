import mongoose, { Schema, Document } from 'mongoose';

export interface IDeviceToken extends Document {
  userId: mongoose.Schema.Types.ObjectId;
  deviceToken: string;
  deviceType: 'ios' | 'android' | 'web';
  isActive: boolean;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deviceTokenSchema = new Schema<IDeviceToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    deviceToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    deviceType: {
      type: String,
      enum: ['ios', 'android', 'web'],
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

export const DeviceToken = mongoose.model<IDeviceToken>(
  'DeviceToken',
  deviceTokenSchema
);
