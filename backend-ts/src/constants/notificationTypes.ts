export const NOTIFICATION_TYPES = {
	BUS_STARTED: 'bus_started',
	BUS_NEAR_STOP: 'bus_near_stop',
	BUS_ARRIVED: 'bus_arrived',
	TRIP_STARTED: 'trip_started',
	TRIP_COMPLETED: 'trip_completed',
	DELAY_ALERT: 'delay_alert',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

