#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');
const polyline = require('@mapbox/polyline');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const routeId = process.argv[2];

if (!routeId) {
    console.error('Usage: node scripts/testRoute.js <routeId>');
    process.exit(1);
}

const SANGAREDDY_BOUNDS = {
    minLat: 17.5,
    maxLat: 17.7,
    minLng: 77.95,
    maxLng: 78.2,
};

const isWithinSangareddyBounds = (lat, lng) =>
    lat >= SANGAREDDY_BOUNDS.minLat &&
    lat <= SANGAREDDY_BOUNDS.maxLat &&
    lng >= SANGAREDDY_BOUNDS.minLng &&
    lng <= SANGAREDDY_BOUNDS.maxLng;

const routeSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        encodedPolyline: { type: String, required: true },
        totalDistanceMeters: { type: Number },
        estimatedDurationSeconds: { type: Number },
    },
    { collection: 'routes' }
);

const Route = mongoose.model('RouteDebug', routeSchema);

const printCoordinates = (label, points) => {
    console.log(label);
    points.forEach((point, index) => {
        console.log(`${index + 1}. ${point.lat}, ${point.lng}`);
    });
};

const main = async () => {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/where-you-are';

    await mongoose.connect(mongoUri);

    const route = await Route.findById(routeId).lean();
    if (!route) {
        console.error(`Route not found: ${routeId}`);
        process.exit(1);
    }

    const decodedPolyline = polyline
        .decode(route.encodedPolyline)
        .map(([lat, lng]) => ({ lat, lng }));

    console.log('Route ID:', String(route._id));
    console.log('Route Name:', route.name);
    console.log('Encoded polyline length:', route.encodedPolyline.length);
    console.log('Decoded points:', decodedPolyline.length);

    const firstTen = decodedPolyline.slice(0, 10);
    const lastTen = decodedPolyline.slice(-10);

    printCoordinates('First 10 coordinates:', firstTen);
    printCoordinates('Last 10 coordinates:', lastTen);

    const sangareddyPoints = decodedPolyline.filter((point) =>
        isWithinSangareddyBounds(point.lat, point.lng)
    );

    console.log('Points in Sangareddy area:', sangareddyPoints.length);
    if (sangareddyPoints.length > 0) {
        printCoordinates('Sample Sangareddy-area points (up to 10):', sangareddyPoints.slice(0, 10));
    }
};

main()
    .catch((error) => {
        console.error('Route debug script failed:', error.message || error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
