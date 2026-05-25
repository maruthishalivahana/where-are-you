import { calculateDistanceMeters } from './calculateDistance';
import { decodePolylineToCoordinates, hasValidPolyline } from '../modules/route/route.polyline.utils';

interface Coordinate {
    latitude: number;
    longitude: number;
}

interface RouteStats {
    totalDistanceMeters?: number;
    estimatedDurationSeconds?: number;
    endLat: number;
    endLng: number;
    polyline?: string;
    timezone?: string;
}

interface StopInput {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    sequenceOrder: number;
    radiusMeters: number;
}

interface EtaOptions {
    current: Coordinate;
    route: RouteStats;
    stops: StopInput[];
}

const FALLBACK_SPEED_MPS = 8.33; // ~30 km/h

const FALLBACK_TIMEZONE = 'UTC';

const buildCumulativeDistances = (coordinates: Array<{ lat: number; lng: number }>): number[] => {
    if (coordinates.length === 0) {
        return [];
    }

    const cumulative = [0];
    for (let index = 1; index < coordinates.length; index += 1) {
        const previous = coordinates[index - 1];
        const current = coordinates[index];
        const segment = calculateDistanceMeters(previous.lat, previous.lng, current.lat, current.lng);
        cumulative.push(cumulative[index - 1] + segment);
    }

    return cumulative;
};

const findNearestPolylineIndex = (
    latitude: number,
    longitude: number,
    polylineCoordinates: Array<{ lat: number; lng: number }>
): number => {
    if (polylineCoordinates.length === 0) {
        return -1;
    }

    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < polylineCoordinates.length; index += 1) {
        const point = polylineCoordinates[index];
        const distance = calculateDistanceMeters(latitude, longitude, point.lat, point.lng);

        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = index;
        }
    }

    return nearestIndex;
};

export const formatDistanceText = (distanceMeters: number): string => {
    const distanceKm = distanceMeters / 1000;
    if (distanceKm >= 1) {
        return `${distanceKm.toFixed(1)} km`;
    }

    return `${Math.round(distanceMeters)} m`;
};

export const formatDurationText = (durationSeconds: number): string => {
    const totalSeconds = Math.max(0, Math.round(durationSeconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes} min`;
    }

    return `${totalSeconds}s`;
};

export const formatRelativeEtaText = (durationSeconds: number): string => {
    const roundedSeconds = Math.round(durationSeconds);

    if (roundedSeconds <= 0) {
        return 'Arriving Now';
    }

    if (roundedSeconds < 60) {
        return 'In <1 min';
    }

    return `In ${Math.ceil(roundedSeconds / 60)} mins`;
};

const resolveTimeZone = (timezone?: string): string => {
    if (!timezone || typeof timezone !== 'string') {
        return FALLBACK_TIMEZONE;
    }

    try {
        // Throws RangeError for unsupported IANA timezone strings.
        Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
        return timezone;
    } catch {
        return FALLBACK_TIMEZONE;
    }
};

export const formatClockTime = (date: Date, timezone?: string): string => {
    const timeZone = resolveTimeZone(timezone);

    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    }).format(date);
};

export const buildEtaSnapshot = ({ current, route, stops }: EtaOptions) => {
    const sortedStops = [...stops].sort((a, b) => a.sequenceOrder - b.sequenceOrder);

    const usePolyline = hasValidPolyline(route.polyline);
    const polylineCoordinates = usePolyline ? decodePolylineToCoordinates(route.polyline!) : [];
    const cumulativeDistances = buildCumulativeDistances(polylineCoordinates);

    const currentPolylineIndex =
        polylineCoordinates.length > 0
            ? findNearestPolylineIndex(current.latitude, current.longitude, polylineCoordinates)
            : -1;

    const stopPolylineIndexes = sortedStops.map((stop) =>
        polylineCoordinates.length > 0
            ? findNearestPolylineIndex(stop.latitude, stop.longitude, polylineCoordinates)
            : -1
    );

    const averageSpeedMps =
        route.totalDistanceMeters && route.estimatedDurationSeconds && route.estimatedDurationSeconds > 0
            ? route.totalDistanceMeters / route.estimatedDurationSeconds
            : FALLBACK_SPEED_MPS;
    const now = new Date();
    const timezone = resolveTimeZone(route.timezone);

    const nearestStopIndex =
        sortedStops.length > 0
            ? sortedStops.reduce((bestIndex, stop, index, arr) => {
                const bestDistance = calculateDistanceMeters(
                    current.latitude,
                    current.longitude,
                    arr[bestIndex].latitude,
                    arr[bestIndex].longitude
                );

                const candidateDistance = calculateDistanceMeters(
                    current.latitude,
                    current.longitude,
                    stop.latitude,
                    stop.longitude
                );

                return candidateDistance < bestDistance ? index : bestIndex;
            }, 0)
            : -1;

    const nearestStopDistanceMeters =
        nearestStopIndex >= 0
            ? calculateDistanceMeters(
                current.latitude,
                current.longitude,
                sortedStops[nearestStopIndex].latitude,
                sortedStops[nearestStopIndex].longitude
            )
            : Number.POSITIVE_INFINITY;

    const withinStopRadiusIndex =
        nearestStopIndex >= 0 && nearestStopDistanceMeters <= Math.max(sortedStops[nearestStopIndex].radiusMeters || 0, 80)
            ? nearestStopIndex
            : -1;

    const currentStopIndexFromPolyline =
        currentPolylineIndex >= 0
            ? stopPolylineIndexes.findIndex((index) => index >= currentPolylineIndex)
            : -1;

    const currentStopIndex =
        withinStopRadiusIndex >= 0
            ? withinStopRadiusIndex
            : currentStopIndexFromPolyline >= 0
                ? currentStopIndexFromPolyline
                : currentPolylineIndex >= 0 && sortedStops.length > 0
                    ? sortedStops.length - 1
                    : nearestStopIndex;

    const normalizedCurrentStopIndex =
        currentStopIndex >= 0
            ? currentStopIndex
            : sortedStops.length > 0
                ? 0
                : -1;

    const stopsWithEta = sortedStops.map((stop, index) => {
        const stopPolylineIndex = stopPolylineIndexes[index];

        const signedDistanceFromCurrentMeters =
            currentPolylineIndex >= 0 && stopPolylineIndex >= 0
                ? cumulativeDistances[stopPolylineIndex] - cumulativeDistances[currentPolylineIndex]
                : normalizedCurrentStopIndex >= 0
                    ? index < normalizedCurrentStopIndex
                        ? -calculateDistanceMeters(current.latitude, current.longitude, stop.latitude, stop.longitude)
                        : calculateDistanceMeters(current.latitude, current.longitude, stop.latitude, stop.longitude)
                    : calculateDistanceMeters(current.latitude, current.longitude, stop.latitude, stop.longitude);

        const distanceFromCurrentMeters =
            currentPolylineIndex >= 0 && stopPolylineIndex >= 0
                ? Math.max(0, cumulativeDistances[stopPolylineIndex] - cumulativeDistances[currentPolylineIndex])
                : calculateDistanceMeters(
                    current.latitude,
                    current.longitude,
                    stop.latitude,
                    stop.longitude
                );

        const etaFromCurrentSecondsRaw = signedDistanceFromCurrentMeters / averageSpeedMps;

        const previousRef = index === 0 ? null : sortedStops[index - 1];
        const previousPolylineIndex = index > 0 ? stopPolylineIndexes[index - 1] : currentPolylineIndex;
        const segmentDistanceMeters =
            previousRef && previousPolylineIndex >= 0 && stopPolylineIndex >= 0
                ? Math.max(0, cumulativeDistances[stopPolylineIndex] - cumulativeDistances[previousPolylineIndex])
                : previousRef
                    ? calculateDistanceMeters(
                        previousRef.latitude,
                        previousRef.longitude,
                        stop.latitude,
                        stop.longitude
                    )
                    : distanceFromCurrentMeters;

        const segmentEtaSeconds = segmentDistanceMeters / averageSpeedMps;

        const status: 'passed' | 'current' | 'upcoming' =
            normalizedCurrentStopIndex >= 0
                ? index < normalizedCurrentStopIndex
                    ? 'passed'
                    : index === normalizedCurrentStopIndex
                        ? 'current'
                        : 'upcoming'
                : 'upcoming';

        const arrivalAt = new Date(now.getTime() + Math.max(0, etaFromCurrentSecondsRaw) * 1000);
        const passedAt = new Date(now.getTime() + Math.min(0, etaFromCurrentSecondsRaw) * 1000);
        const arrivalClockTimeText = formatClockTime(arrivalAt, timezone);
        const departedClockTimeText = status === 'passed' ? formatClockTime(passedAt, timezone) : null;

        const leftSubLabel =
            status === 'passed'
                ? departedClockTimeText
                    ? `Departed ${departedClockTimeText}`
                    : 'Departed'
                : status === 'current'
                    ? 'Arriving Now'
                    : formatRelativeEtaText(etaFromCurrentSecondsRaw);

        const rightPrimaryLabel =
            status === 'passed'
                ? 'Passed'
                : status === 'current'
                    ? formatClockTime(now, timezone)
                    : arrivalClockTimeText;

        const rightSecondaryLabel = status === 'current' ? 'CURRENT' : null;

        return {
            ...stop,
            isPassed: status === 'passed',
            distanceFromCurrentMeters,
            distanceFromCurrentText: formatDistanceText(distanceFromCurrentMeters),
            etaFromCurrentSeconds: Math.round(etaFromCurrentSecondsRaw),
            etaFromCurrentText: formatRelativeEtaText(etaFromCurrentSecondsRaw),
            segmentDistanceMeters,
            segmentDistanceText: formatDistanceText(segmentDistanceMeters),
            segmentEtaSeconds: Math.round(segmentEtaSeconds),
            segmentEtaText: formatDurationText(segmentEtaSeconds),
            arrivalClockTimeText,
            departedClockTimeText,
            status,
            leftSubLabel,
            rightPrimaryLabel,
            rightSecondaryLabel,
        };
    });

    const distanceToDestinationMeters =
        currentPolylineIndex >= 0 && cumulativeDistances.length > 0
            ? Math.max(0, cumulativeDistances[cumulativeDistances.length - 1] - cumulativeDistances[currentPolylineIndex])
            : calculateDistanceMeters(current.latitude, current.longitude, route.endLat, route.endLng);
    const etaToDestinationSeconds = distanceToDestinationMeters / averageSpeedMps;

    return {
        averageSpeedMps,
        averageSpeedKmph: Number((averageSpeedMps * 3.6).toFixed(1)),
        distanceToDestinationMeters,
        distanceToDestinationText: formatDistanceText(distanceToDestinationMeters),
        etaToDestinationSeconds: Math.round(etaToDestinationSeconds),
        etaToDestinationText: formatDurationText(etaToDestinationSeconds),
        routeDistanceText: formatDistanceText(route.totalDistanceMeters || 0),
        routeDurationText: formatDurationText(route.estimatedDurationSeconds || 0),
        stopsWithEta,
    };
};
