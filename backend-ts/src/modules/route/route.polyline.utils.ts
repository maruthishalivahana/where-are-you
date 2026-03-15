import { createHash } from 'crypto';

const polyline = require('@mapbox/polyline') as {
    decode: (encoded: string) => [number, number][];
    encode: (coordinates: [number, number][]) => string;
};

export const MAX_DIRECTIONS_WAYPOINTS = 23;

export interface Coordinate {
    lat: number;
    lng: number;
}

export interface NormalizedStop {
    _id: string;
    name: string;
    lat: number;
    lng: number;
    order: number;
    createdAt: Date;
}

export interface DirectionsSegment {
    origin: Coordinate;
    destination: Coordinate;
    waypoints: Coordinate[];
}

export const hasValidPolyline = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

export const normalizeAndSortStops = (
    rawStops: Array<{
        _id: unknown;
        name: string;
        latitude: number;
        longitude: number;
        sequenceOrder: number;
        createdAt?: Date;
    }>
): NormalizedStop[] => {
    return rawStops
        .map((stop) => ({
            _id: String(stop._id),
            name: stop.name,
            lat: stop.latitude,
            lng: stop.longitude,
            order: stop.sequenceOrder,
            createdAt: stop.createdAt ? new Date(stop.createdAt) : new Date(0),
        }))
        .sort((a, b) => {
            if (a.order !== b.order) {
                return a.order - b.order;
            }

            const createdAtDiff = a.createdAt.getTime() - b.createdAt.getTime();
            if (createdAtDiff !== 0) {
                return createdAtDiff;
            }

            return a._id.localeCompare(b._id);
        });
};

export const computeStopsHash = (orderedStops: NormalizedStop[]): string => {
    const normalizedForHash = orderedStops.map((stop) => ({
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        order: stop.order,
    }));

    return createHash('sha256').update(JSON.stringify(normalizedForHash)).digest('hex');
};

export const buildRouteSignature = (origin: Coordinate, destination: Coordinate): string =>
    `${origin.lat},${origin.lng}|${destination.lat},${destination.lng}`;

export const buildDirectionSegments = (
    origin: Coordinate,
    destination: Coordinate,
    orderedStops: NormalizedStop[],
    maxWaypointsPerRequest: number = MAX_DIRECTIONS_WAYPOINTS
): DirectionsSegment[] => {
    const points: Coordinate[] = [origin, ...orderedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })), destination];

    const maxPointsPerSegment = maxWaypointsPerRequest + 2;
    const segments: DirectionsSegment[] = [];

    let segmentStartIndex = 0;
    while (segmentStartIndex < points.length - 1) {
        const remainingPoints = points.length - segmentStartIndex;
        const segmentPointCount = Math.min(maxPointsPerSegment, remainingPoints);
        const segmentEndIndex = segmentStartIndex + segmentPointCount - 1;

        const segmentPoints = points.slice(segmentStartIndex, segmentEndIndex + 1);
        segments.push({
            origin: segmentPoints[0],
            destination: segmentPoints[segmentPoints.length - 1],
            waypoints: segmentPoints.slice(1, -1),
        });

        if (segmentEndIndex === points.length - 1) {
            break;
        }

        segmentStartIndex = segmentEndIndex;
    }

    return segments;
};

export const decodePolylineToCoordinates = (encodedPolyline: string): Coordinate[] => {
    return polyline.decode(encodedPolyline).map(([lat, lng]) => ({ lat, lng }));
};

export const encodeCoordinatesToPolyline = (coordinates: Coordinate[]): string => {
    if (coordinates.length === 0) {
        return '';
    }

    return polyline.encode(coordinates.map((point) => [point.lat, point.lng]));
};

export const mergeCoordinateSegments = (segments: Coordinate[][]): Coordinate[] => {
    const merged: Coordinate[] = [];

    segments.forEach((segment, index) => {
        if (segment.length === 0) {
            return;
        }

        if (index === 0) {
            merged.push(...segment);
            return;
        }

        merged.push(...segment.slice(1));
    });

    return merged;
};

const EARTH_RADIUS_METERS = 6371000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const haversineDistanceMeters = (a: Coordinate, b: Coordinate): number => {
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);

    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);

    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);

    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
};

const pointToSegmentDistanceMeters = (point: Coordinate, segmentStart: Coordinate, segmentEnd: Coordinate): number => {
    const latScale = 111320;
    const lngScale = 111320 * Math.cos(toRadians(point.lat));

    const px = point.lng * lngScale;
    const py = point.lat * latScale;

    const x1 = segmentStart.lng * lngScale;
    const y1 = segmentStart.lat * latScale;

    const x2 = segmentEnd.lng * lngScale;
    const y2 = segmentEnd.lat * latScale;

    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
        return haversineDistanceMeters(point, segmentStart);
    }

    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    const proj = {
        lng: (x1 + t * dx) / lngScale,
        lat: (y1 + t * dy) / latScale,
    };

    return haversineDistanceMeters(point, proj);
};

export const minimumDistanceToPolylineMeters = (point: Coordinate, polylineCoordinates: Coordinate[]): number => {
    if (polylineCoordinates.length === 0) {
        return Number.POSITIVE_INFINITY;
    }

    if (polylineCoordinates.length === 1) {
        return haversineDistanceMeters(point, polylineCoordinates[0]);
    }

    let minDistance = Number.POSITIVE_INFINITY;

    for (let i = 1; i < polylineCoordinates.length; i += 1) {
        const distance = pointToSegmentDistanceMeters(point, polylineCoordinates[i - 1], polylineCoordinates[i]);
        if (distance < minDistance) {
            minDistance = distance;
        }
    }

    return minDistance;
};

export const areStopsNearPolyline = (
    encodedPolyline: string,
    orderedStops: Array<Pick<NormalizedStop, 'lat' | 'lng'>>,
    toleranceMeters: number = 120
): boolean => {
    if (!hasValidPolyline(encodedPolyline)) {
        return false;
    }

    const decoded = decodePolylineToCoordinates(encodedPolyline);
    return orderedStops.every((stop) =>
        minimumDistanceToPolylineMeters({ lat: stop.lat, lng: stop.lng }, decoded) <= toleranceMeters
    );
};
