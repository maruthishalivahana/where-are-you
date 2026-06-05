import mongoose, { Document, Schema } from 'mongoose';
import { NOTIFICATION_TYPES, NotificationType } from '../../constants/notificationTypes';

export interface INotification extends Document {
	organizationId: mongoose.Types.ObjectId;
	userId: mongoose.Types.ObjectId;
	busId?: mongoose.Types.ObjectId | null;
	tripId?: mongoose.Types.ObjectId | null;
	stopId?: mongoose.Types.ObjectId | null;
	type: NotificationType;
	title: string;
	message: string;
	voiceMessage?: string;
	payload?: Record<string, unknown>;
	isRead: boolean;
	deliveredAt?: Date | null;
	failureReason?: string | null;
	retryCount: number;
	createdAt: Date;
	updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
	{
		organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
		userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
		busId: { type: Schema.Types.ObjectId, ref: 'Bus', default: null },
		tripId: { type: Schema.Types.ObjectId, ref: 'Trip', default: null, index: true },
		stopId: { type: Schema.Types.ObjectId, ref: 'Stop', default: null },
		type: {
			type: String,
			enum: Object.values(NOTIFICATION_TYPES),
			required: true,
		},
		title: { type: String, required: true },
		message: { type: String, required: true },
		voiceMessage: { type: String, default: null },
		payload: { type: Schema.Types.Mixed, default: {} },
		isRead: { type: Boolean, default: false },
		deliveredAt: { type: Date, default: null },
		failureReason: { type: String, default: null },
		retryCount: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

