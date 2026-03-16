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

    const stopsWithEta = sortedStops.map((stop, index) => {
        const stopPolylineIndex = stopPolylineIndexes[index];

        const distanceFromCurrentMeters =
            currentPolylineIndex >= 0 && stopPolylineIndex >= 0
                ? Math.max(0, cumulativeDistances[stopPolylineIndex] - cumulativeDistances[currentPolylineIndex])
                : calculateDistanceMeters(
                      current.latitude,
                      current.longitude,
                      stop.latitude,
                      stop.longitude
                  );

        const etaFromCurrentSeconds = distanceFromCurrentMeters / averageSpeedMps;

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

        return {
            ...stop,
            isPassed:
                currentPolylineIndex >= 0 && stopPolylineIndex >= 0
                    ? stopPolylineIndex < currentPolylineIndex
                    : nearestStopIndex >= 0
                      ? index < nearestStopIndex
                      : false,
            distanceFromCurrentMeters,
            distanceFromCurrentText: formatDistanceText(distanceFromCurrentMeters),
            etaFromCurrentSeconds: Math.round(etaFromCurrentSeconds),
            etaFromCurrentText: formatDurationText(etaFromCurrentSeconds),
            segmentDistanceMeters,
            segmentDistanceText: formatDistanceText(segmentDistanceMeters),
            segmentEtaSeconds: Math.round(segmentEtaSeconds),
            segmentEtaText: formatDurationText(segmentEtaSeconds),
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
