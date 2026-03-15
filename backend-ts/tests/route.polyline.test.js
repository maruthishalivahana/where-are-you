const test = require('node:test');
const assert = require('node:assert/strict');
const {
    areStopsNearPolyline,
    buildDirectionSegments,
    computeStopsHash,
    encodeCoordinatesToPolyline,
    normalizeAndSortStops,
} = require('../src/modules/route/route.polyline.utils');
const { buildOwnedRouteQuery } = require('../src/modules/route/route.service');

test('builds strict org-scoped route lookup query', () => {
    assert.deepEqual(buildOwnedRouteQuery('org-1', 'route-1'), {
        _id: 'route-1',
        organizationId: 'org-1',
    });
});

test('normalizes and sorts stops deterministically', () => {
    const raw = [
        {
            _id: 'b-stop',
            name: 'Stop B',
            latitude: 17.61,
            longitude: 78.11,
            sequenceOrder: 2,
            createdAt: new Date('2025-01-02T00:00:00.000Z'),
        },
        {
            _id: 'a-stop-late',
            name: 'Stop A2',
            latitude: 17.6,
            longitude: 78.1,
            sequenceOrder: 1,
            createdAt: new Date('2025-01-03T00:00:00.000Z'),
        },
        {
            _id: 'a-stop-early',
            name: 'Stop A1',
            latitude: 17.59,
            longitude: 78.09,
            sequenceOrder: 1,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
    ];

    const normalized = normalizeAndSortStops(raw);

    assert.deepEqual(
        normalized.map((stop) => stop._id),
        ['a-stop-early', 'a-stop-late', 'b-stop']
    );
    assert.deepEqual(
        normalized.map((stop) => stop.order),
        [1, 1, 2]
    );
});

test('splits large waypoint routes into valid segment chunks', () => {
    const orderedStops = Array.from({ length: 30 }, (_, index) => ({
        _id: `stop-${index + 1}`,
        name: `Stop ${index + 1}`,
        lat: 17.5 + index * 0.001,
        lng: 78.0 + index * 0.001,
        order: index + 1,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }));

    const segments = buildDirectionSegments(
        { lat: 17.48, lng: 77.98 },
        { lat: 17.9, lng: 78.45 },
        orderedStops,
        10
    );

    assert.ok(segments.length > 1);
    assert.ok(segments.every((segment) => segment.waypoints.length <= 10));

    const rebuiltPath = [segments[0].origin];
    for (const segment of segments) {
        rebuiltPath.push(...segment.waypoints, segment.destination);
    }

    const expectedPath = [
        { lat: 17.48, lng: 77.98 },
        ...orderedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
        { lat: 17.9, lng: 78.45 },
    ];

    assert.equal(rebuiltPath.length, expectedPath.length);
    assert.deepEqual(rebuiltPath, expectedPath);
});

test('changes stops hash when ordered stop data changes', () => {
    const orderedStops = normalizeAndSortStops([
        {
            _id: 'stop-1',
            name: 'Stop 1',
            latitude: 17.6,
            longitude: 78.1,
            sequenceOrder: 1,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
    ]);

    const originalHash = computeStopsHash(orderedStops);

    const updatedStops = normalizeAndSortStops([
        {
            _id: 'stop-1',
            name: 'Stop 1',
            latitude: 17.601,
            longitude: 78.1,
            sequenceOrder: 1,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
    ]);

    const updatedHash = computeStopsHash(updatedStops);
    assert.notEqual(originalHash, updatedHash);
});

test('polyline stays within tolerance for every ordered stop', () => {
    const encodedPolyline = encodeCoordinatesToPolyline([
        { lat: 17.6000, lng: 78.1000 },
        { lat: 17.6100, lng: 78.1100 },
        { lat: 17.6200, lng: 78.1200 },
    ]);

    const nearStops = [
        { lat: 17.6002, lng: 78.1001 },
        { lat: 17.6102, lng: 78.1102 },
        { lat: 17.6198, lng: 78.1199 },
    ];

    const farStops = [
        { lat: 17.68, lng: 78.22 },
    ];

    assert.equal(areStopsNearPolyline(encodedPolyline, nearStops, 80), true);
    assert.equal(areStopsNearPolyline(encodedPolyline, farStops, 80), false);
});
