const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEtaSnapshot, formatClockTime, formatRelativeEtaText } = require('../src/utils/eta');

const FIXED_NOW = new Date('2026-04-16T12:40:00.000Z');

const RealDate = Date;

const installFixedDate = () => {
    global.Date = class extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                return new RealDate(FIXED_NOW.getTime());
            }

            return new RealDate(...args);
        }

        static now() {
            return FIXED_NOW.getTime();
        }

        static parse(value) {
            return RealDate.parse(value);
        }

        static UTC(...args) {
            return RealDate.UTC(...args);
        }
    };
};

const restoreDate = () => {
    global.Date = RealDate;
};

test('buildEtaSnapshot assigns passed/current/upcoming timeline labels', () => {
    installFixedDate();

    try {
        const snapshot = buildEtaSnapshot({
            current: { latitude: 17.61, longitude: 78.11 },
            route: {
                totalDistanceMeters: 3000,
                estimatedDurationSeconds: 360,
                endLat: 17.62,
                endLng: 78.12,
                timezone: 'Asia/Kolkata',
            },
            stops: [
                {
                    id: 's1',
                    name: 'Stop 1',
                    latitude: 17.6,
                    longitude: 78.1,
                    sequenceOrder: 1,
                    radiusMeters: 120,
                },
                {
                    id: 's2',
                    name: 'Stop 2',
                    latitude: 17.61,
                    longitude: 78.11,
                    sequenceOrder: 2,
                    radiusMeters: 120,
                },
                {
                    id: 's3',
                    name: 'Stop 3',
                    latitude: 17.62,
                    longitude: 78.12,
                    sequenceOrder: 3,
                    radiusMeters: 120,
                },
            ],
        });

        assert.equal(snapshot.stopsWithEta.length, 3);

        const passed = snapshot.stopsWithEta[0];
        const current = snapshot.stopsWithEta[1];
        const upcoming = snapshot.stopsWithEta[2];

        assert.equal(passed.status, 'passed');
        assert.equal(passed.rightPrimaryLabel, 'Passed');
        assert.equal(passed.isPassed, true);
        assert.match(passed.leftSubLabel, /^Departed /);
        assert.ok(typeof passed.departedClockTimeText === 'string' && passed.departedClockTimeText.length > 0);

        assert.equal(current.status, 'current');
        assert.equal(current.leftSubLabel, 'Arriving Now');
        assert.equal(current.rightSecondaryLabel, 'CURRENT');
        assert.equal(current.rightPrimaryLabel, '6:10 PM');

        assert.equal(upcoming.status, 'upcoming');
        assert.match(upcoming.leftSubLabel, /^In /);
        assert.match(upcoming.arrivalClockTimeText, /^[0-9]{1,2}:[0-9]{2} [AP]M$/);
        assert.equal(upcoming.rightPrimaryLabel, upcoming.arrivalClockTimeText);
    } finally {
        restoreDate();
    }
});

test('relative ETA formatter handles negative and sub-minute durations deterministically', () => {
    assert.equal(formatRelativeEtaText(-1), 'Arriving Now');
    assert.equal(formatRelativeEtaText(0), 'Arriving Now');
    assert.equal(formatRelativeEtaText(30), 'In <1 min');
    assert.equal(formatRelativeEtaText(61), 'In 2 mins');
});

test('clock formatter uses timezone and falls back safely for invalid timezone', () => {
    const date = new Date('2026-04-16T12:40:00.000Z');

    assert.equal(formatClockTime(date, 'Asia/Kolkata'), '6:10 PM');
    assert.equal(formatClockTime(date, 'Invalid/Timezone'), '12:40 PM');
});

test('buildEtaSnapshot uses fallback speed when route segment timing metadata is missing', () => {
    const snapshot = buildEtaSnapshot({
        current: { latitude: 17.6, longitude: 78.1 },
        route: {
            endLat: 17.62,
            endLng: 78.12,
            timezone: 'UTC',
        },
        stops: [
            {
                id: 's1',
                name: 'Stop 1',
                latitude: 17.61,
                longitude: 78.11,
                sequenceOrder: 1,
                radiusMeters: 100,
            },
        ],
    });

    assert.ok(snapshot.averageSpeedMps > 0);
    assert.ok(Number.isFinite(snapshot.stopsWithEta[0].segmentEtaSeconds));
    assert.ok(snapshot.stopsWithEta[0].segmentEtaSeconds >= 0);
});
