import axios from 'axios';
import { Route } from './route.model';
import { ENV } from '../../config/env.config';
import { Stop } from '../stop/stop.model';
import {
    Coordinate,
    NormalizedStop,
    areStopsNearPolyline,
    buildDirectionSegments,
    buildRouteSignature,
    computeStopsHash,
    decodePolylineToCoordinates,
    encodeCoordinatesToPolyline,
    hasValidPolyline,
    mergeCoordinateSegments,
    normalizeAndSortStops,
} from './route.polyline.utils';

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const DIRECTIONS_TIMEOUT_MS = 5000;
const DIRECTIONS_MAX_ATTEMPTS = 3;
const SANGAREDDY_BOUNDS = {
    minLat: 17.5,
    maxLat: 17.7,
    minLng: 77.95,
    maxLng: 78.2,
};

const isWithinSangareddyBounds = (lat: number, lng: number): boolean =>
    lat >= SANGAREDDY_BOUNDS.minLat &&
    lat <= SANGAREDDY_BOUNDS.maxLat &&
    lng >= SANGAREDDY_BOUNDS.minLng &&
    lng <= SANGAREDDY_BOUNDS.maxLng;

interface CreateRouteInput {
    name: string;
    startLat: number;
    startLng: number;
    endLat: number;
    endLng: number;
}

interface UpdateRouteInput {
    name?: string;
    startLat?: number;
    startLng?: number;
    endLat?: number;
    endLng?: number;
    isActive?: boolean;
}

interface DirectionsResponse {
    status: string;
    routes: Array<{
        overview_polyline: { points: string };
        legs: Array<{
            distance: { value: number };
            duration: { value: number };
        }>;
    }>;
    error_message?: string;
}

interface RouteGeometry {
    polyline: string;
    totalDistanceMeters: number;
    estimatedDurationSeconds: number;
}

interface PolylinePreparationResult {
    route: InstanceType<typeof Route>;
    polyline: string;
    orderedStops: NormalizedStop[];
    generationSource: 'cache' | 'regenerated';
    regenerationReason: string;
}

const toLatLngString = (coordinate: Coordinate): string => `${coordinate.lat},${coordinate.lng}`;

export const buildOwnedRouteQuery = (organizationId: string, routeId: string) => ({
    _id: routeId,
    organizationId,
});

const delay = async (milliseconds: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const getStoredPolyline = (route: InstanceType<typeof Route>): string => {
    if (hasValidPolyline(route.polyline)) {
        return route.polyline;
    }

    if (hasValidPolyline(route.encodedPolyline)) {
        return route.encodedPolyline;
    }

    return '';
};

const getOrderedStopsForRoute = async (
    organizationId: string,
    routeId: string
): Promise<NormalizedStop[]> => {
    const stops = await Stop.find({ organizationId, routeId })
        .select('name latitude longitude sequenceOrder createdAt')
        .lean();

    return normalizeAndSortStops(stops);
};

const getDirectionsChunk = async (
    origin: Coordinate,
    destination: Coordinate,
    waypoints: Coordinate[] = []
): Promise<DirectionsResponse['routes'][number]> => {
    if (!ENV.GOOGLE_MAPS_API_KEY) {
        throw new Error('Google Maps API key is not configured');
    }

    let lastErrorMessage = 'Unknown directions provider error';

    for (let attempt = 1; attempt <= DIRECTIONS_MAX_ATTEMPTS; attempt += 1) {
        try {
            const { data } = await axios.get<DirectionsResponse>(DIRECTIONS_URL, {
                timeout: DIRECTIONS_TIMEOUT_MS,
                params: {
                    origin: toLatLngString(origin),
                    destination: toLatLngString(destination),
                    mode: 'driving',
                    waypoints: waypoints.length > 0 ? waypoints.map(toLatLngString).join('|') : undefined,
                    key: ENV.GOOGLE_MAPS_API_KEY,
                },
            });

            if (data.status !== 'OK' || data.routes.length === 0) {
                lastErrorMessage = data.error_message || `Google Directions API returned status: ${data.status}`;
            } else {
                return data.routes[0];
            }
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNABORTED') {
                    lastErrorMessage = `Google Directions API timed out after ${DIRECTIONS_TIMEOUT_MS}ms`;
                } else {
                    lastErrorMessage = error.message;
                }
            } else if (error instanceof Error) {
                lastErrorMessage = error.message;
            }
        }

        if (attempt < DIRECTIONS_MAX_ATTEMPTS) {
            await delay(200 * attempt);
        }
    }

    throw new Error(
        `Directions provider failed after ${DIRECTIONS_MAX_ATTEMPTS} attempts: ${lastErrorMessage}`
    );
};

const getRouteGeometry = async (
    origin: Coordinate,
    destination: Coordinate,
    orderedStops: NormalizedStop[] = []
): Promise<RouteGeometry> => {
    const segments = buildDirectionSegments(origin, destination, orderedStops);
    const decodedSegments: Coordinate[][] = [];
    let totalDistanceMeters = 0;
    let estimatedDurationSeconds = 0;

    for (const segment of segments) {
        const result = await getDirectionsChunk(
            segment.origin,
            segment.destination,
            segment.waypoints
        );

        const segmentPolyline = result.overview_polyline?.points;
        if (!hasValidPolyline(segmentPolyline)) {
            throw new Error('Directions provider returned an empty encoded polyline');
        }

        decodedSegments.push(decodePolylineToCoordinates(segmentPolyline));
        totalDistanceMeters += result.legs.reduce((total, leg) => total + (leg.distance?.value ?? 0), 0);
        estimatedDurationSeconds += result.legs.reduce((total, leg) => total + (leg.duration?.value ?? 0), 0);
    }

    const mergedCoordinates = mergeCoordinateSegments(decodedSegments);
    const mergedPolyline = encodeCoordinatesToPolyline(mergedCoordinates);

    if (!hasValidPolyline(mergedPolyline)) {
        throw new Error('Failed to generate a non-empty encoded polyline');
    }

    return {
        polyline: mergedPolyline,
        totalDistanceMeters,
        estimatedDurationSeconds,
    };
};

const markRouteAsPolylineDirty = (route: InstanceType<typeof Route>): void => {
    route.version = (route.version ?? 1) + 1;
    route.polylineStopsHash = '';
    route.polylineRouteSignature = '';
    route.polylineVersion = 0;
    route.polylineGeneratedAt = undefined;
};

const resolveRegenerationReason = (
    route: InstanceType<typeof Route>,
    storedPolyline: string,
    stopsHash: string,
    routeSignature: string,
    forceRefresh: boolean
): string | null => {
    if (forceRefresh) {
        return 'forced_refresh';
    }

    if (!hasValidPolyline(storedPolyline)) {
        return 'polyline_missing';
    }

    if (route.polylineStopsHash !== stopsHash) {
        return 'stops_hash_changed';
    }

    if (route.polylineRouteSignature !== routeSignature) {
        return 'route_start_end_changed';
    }

    if ((route.polylineVersion ?? 0) !== (route.version ?? 1)) {
        return 'route_version_changed';
    }

    return null;
};

const ensureRoutePolyline = async (
    organizationId: string,
    route: InstanceType<typeof Route>,
    options: { forceRefresh?: boolean } = {}
): Promise<PolylinePreparationResult> => {
    const orderedStops = await getOrderedStopsForRoute(organizationId, String(route._id));
    const stopsHash = computeStopsHash(orderedStops);
    const routeSignature = buildRouteSignature(
        { lat: route.startLat, lng: route.startLng },
        { lat: route.endLat, lng: route.endLng }
    );
    const currentPolyline = getStoredPolyline(route);

    const hasMissingMetadata =
        !route.polylineStopsHash || !route.polylineRouteSignature || (route.polylineVersion ?? 0) === 0;

    if (
        hasValidPolyline(currentPolyline) &&
        options.forceRefresh !== true &&
        hasMissingMetadata &&
        areStopsNearPolyline(currentPolyline, orderedStops, 150)
    ) {
        route.polyline = currentPolyline;
        route.encodedPolyline = currentPolyline;
        route.polylineStopsHash = stopsHash;
        route.polylineRouteSignature = routeSignature;
        route.polylineGeneratedAt = route.polylineGeneratedAt || new Date();
        route.polylineVersion = route.version ?? 1;
        await route.save();

        return {
            route,
            polyline: currentPolyline,
            orderedStops,
            generationSource: 'cache',
            regenerationReason: 'metadata_backfilled',
        };
    }

    const regenerationReason = resolveRegenerationReason(
        route,
        currentPolyline,
        stopsHash,
        routeSignature,
        options.forceRefresh === true
    );

    if (!regenerationReason) {
        if (!hasValidPolyline(route.polyline) || route.encodedPolyline !== route.polyline) {
            route.polyline = currentPolyline;
            route.encodedPolyline = currentPolyline;
            await route.save();
        }

        return {
            route,
            polyline: currentPolyline,
            orderedStops,
            generationSource: 'cache',
            regenerationReason: 'cached',
        };
    }

    const geometry = await getRouteGeometry(
        { lat: route.startLat, lng: route.startLng },
        { lat: route.endLat, lng: route.endLng },
        orderedStops
    );

    if (!hasValidPolyline(geometry.polyline)) {
        throw new Error('Directions provider returned an invalid polyline');
    }

    route.polyline = geometry.polyline;
    route.encodedPolyline = geometry.polyline;
    route.polylineStopsHash = stopsHash;
    route.polylineRouteSignature = routeSignature;
    route.polylineGeneratedAt = new Date();
    route.polylineVersion = route.version ?? 1;
    route.totalDistanceMeters = geometry.totalDistanceMeters;
    route.estimatedDurationSeconds = geometry.estimatedDurationSeconds;
    await route.save();

    return {
        route,
        polyline: geometry.polyline,
        orderedStops,
        generationSource: 'regenerated',
        regenerationReason,
    };
};

export const routeService = {
    createRoute: async (organizationId: string, input: CreateRouteInput) => {
        const existing = await Route.findOne({ organizationId, name: input.name });
        if (existing) {
            throw new Error(`Route with name "${input.name}" already exists`);
        }

        const geometry = await getRouteGeometry(
            { lat: input.startLat, lng: input.startLng },
            { lat: input.endLat, lng: input.endLng },
            []
        );

        const initialStopsHash = computeStopsHash([]);
        const initialSignature = buildRouteSignature(
            { lat: input.startLat, lng: input.startLng },
            { lat: input.endLat, lng: input.endLng }
        );

        const route = await Route.create({
            organizationId,
            name: input.name.trim(),
            startLat: input.startLat,
            startLng: input.startLng,
            endLat: input.endLat,
            endLng: input.endLng,
            version: 1,
            polyline: geometry.polyline,
            encodedPolyline: geometry.polyline,
            polylineStopsHash: initialStopsHash,
            polylineGeneratedAt: new Date(),
            polylineVersion: 1,
            polylineRouteSignature: initialSignature,
            totalDistanceMeters: geometry.totalDistanceMeters,
            estimatedDurationSeconds: geometry.estimatedDurationSeconds,
        });

        return formatRoute(route);
    },

    updateRoute: async (organizationId: string, routeId: string, input: UpdateRouteInput) => {
        const route = await Route.findOne(buildOwnedRouteQuery(organizationId, routeId));
        if (!route) {
            throw new Error('Route not found');
        }

        let hasRouteChanged = false;

        const nextName = input.name?.trim();
        if (nextName && nextName !== route.name) {
            const duplicate = await Route.findOne({
                organizationId,
                name: nextName,
                _id: { $ne: route._id },
            });

            if (duplicate) {
                throw new Error(`Route with name "${nextName}" already exists`);
            }

            route.name = nextName;
            hasRouteChanged = true;
        }

        if (input.startLat !== undefined && input.startLat !== route.startLat) {
            route.startLat = input.startLat;
            hasRouteChanged = true;
        }

        if (input.startLng !== undefined && input.startLng !== route.startLng) {
            route.startLng = input.startLng;
            hasRouteChanged = true;
        }

        if (input.endLat !== undefined && input.endLat !== route.endLat) {
            route.endLat = input.endLat;
            hasRouteChanged = true;
        }

        if (input.endLng !== undefined && input.endLng !== route.endLng) {
            route.endLng = input.endLng;
            hasRouteChanged = true;
        }

        if (input.isActive !== undefined && input.isActive !== route.isActive) {
            route.isActive = input.isActive;
            hasRouteChanged = true;
        }

        if (hasRouteChanged) {
            markRouteAsPolylineDirty(route);
        }

        await route.save();
        return formatRoute(route);
    },

    markRoutePolylineDirty: async (
        organizationId: string,
        routeId: string,
        _reason: string = 'route_mutation'
    ) => {
        const route = await Route.findOne(buildOwnedRouteQuery(organizationId, routeId));
        if (!route) {
            throw new Error('Route not found');
        }

        markRouteAsPolylineDirty(route);
        await route.save();

        return formatRoute(route);
    },

    recalculateRoutePolyline: async (organizationId: string, routeId: string) => {
        const route = await Route.findOne(buildOwnedRouteQuery(organizationId, routeId));
        if (!route) {
            throw new Error('Route not found');
        }

        const prepared = await ensureRoutePolyline(organizationId, route, { forceRefresh: true });
        return formatRoute(prepared.route);
    },

    getRoutes: async (organizationId: string) => {
        const routes = await Route.find({ organizationId }).sort({ createdAt: -1 });
        return routes.map(formatRoute);
    },

    getRouteById: async (organizationId: string, routeId: string) => {
        const routeDoc = await Route.findOne(buildOwnedRouteQuery(organizationId, routeId));
        if (!routeDoc) {
            throw new Error('Route not found');
        }

        const prepared = await ensureRoutePolyline(organizationId, routeDoc);
        return formatRoute(prepared.route);
    },

    getRouteMapDataById: async (organizationId: string, routeId: string) => {
        const routeDoc = await Route.findOne(buildOwnedRouteQuery(organizationId, routeId));
        if (!routeDoc) {
            throw new Error('Route not found');
        }

        console.log('Requested routeId:', routeId);
        console.log('Matched routeId:', String(routeDoc._id));
        console.log('OrganizationId:', String(routeDoc.organizationId));

        const prepared = await ensureRoutePolyline(organizationId, routeDoc);
        const route = prepared.route;

        console.log({
            routeId: String(route._id),
            stopCount: prepared.orderedStops.length,
            orderedStopIds: prepared.orderedStops.map((stop) => stop._id),
            polylineLength: prepared.polyline.length,
            generationSource: prepared.generationSource,
            regenerationReason: prepared.regenerationReason,
        });

        const normalizedStops = prepared.orderedStops.map((stop) => ({
            name: stop.name,
            lat: stop.lat,
            lng: stop.lng,
            order: stop.order,
        }));

        return {
            routeId: String(route._id),
            polyline: prepared.polyline,
            stops: normalizedStops,
            id: String(route._id),
            name: route.name,
            encodedPolyline: prepared.polyline,
            route_id: String(route._id),
            start: {
                lat: route.startLat,
                lng: route.startLng,
            },
            destination: {
                lat: route.endLat,
                lng: route.endLng,
            },
        };
    },

    getRouteDebugById: async (organizationId: string, routeId: string) => {
        const routeDoc = await Route.findOne(buildOwnedRouteQuery(organizationId, routeId));
        if (!routeDoc) {
            throw new Error('Route not found');
        }

        const prepared = await ensureRoutePolyline(organizationId, routeDoc);
        const route = prepared.route;
        const decodedPolyline = decodePolylineToCoordinates(prepared.polyline);
        const pointsInSangareddy = decodedPolyline.filter((point) =>
            isWithinSangareddyBounds(point.lat, point.lng)
        ).length;

        console.log('Route ID:', route._id);
        console.log('Encoded polyline length:', prepared.polyline.length);
        console.log('Decoded points:', decodedPolyline.length);
        console.log('Points in Sangareddy area:', pointsInSangareddy);

        return {
            routeId: String(route._id),
            name: route.name,
            encodedPolyline: prepared.polyline,
            decodedPolyline,
            totalDistanceMeters: route.totalDistanceMeters,
            estimatedDurationSeconds: route.estimatedDurationSeconds,
        };
    },

    deleteRoute: async (organizationId: string, routeId: string) => {
        const route = await Route.findOneAndDelete({ _id: routeId, organizationId });
        if (!route) {
            throw new Error('Route not found');
        }
        return { message: 'Route deleted successfully' };
    },
};

const formatRoute = (route: InstanceType<typeof Route>) => ({
    id: String(route._id),
    name: route.name,
    startLat: route.startLat,
    startLng: route.startLng,
    endLat: route.endLat,
    endLng: route.endLng,
    version: route.version,
    polyline: hasValidPolyline(route.polyline) ? route.polyline : route.encodedPolyline,
    encodedPolyline: hasValidPolyline(route.polyline) ? route.polyline : route.encodedPolyline,
    polylineStopsHash: route.polylineStopsHash,
    polylineGeneratedAt: route.polylineGeneratedAt,
    polylineVersion: route.polylineVersion,
    polylineRouteSignature: route.polylineRouteSignature,
    totalDistanceMeters: route.totalDistanceMeters,
    estimatedDurationSeconds: route.estimatedDurationSeconds,
    isActive: route.isActive,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
});
