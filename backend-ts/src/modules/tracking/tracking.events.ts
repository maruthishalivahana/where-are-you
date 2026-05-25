export const TRACKING_EVENTS = {
	JOIN_BUS_ROOM: 'joinBusRoom',
	JOIN_ROUTE_ROOM: 'joinRoute',
	DRIVER_LOCATION_UPDATE: 'driverLocationUpdate',
	BUS_LOCATION_UPDATE: 'busLocationUpdate',
	STOP_UPDATE: 'stopUpdate',
	ETA_UPDATE: 'etaUpdate',
} as const;

export type TrackingEventName = (typeof TRACKING_EVENTS)[keyof typeof TRACKING_EVENTS];
