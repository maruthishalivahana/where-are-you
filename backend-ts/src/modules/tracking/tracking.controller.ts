import { Request, Response } from 'express';
import { trackingService } from './tracking.service';
import { batchTrackingService } from '../../services/batch-tracking.service';
import { logger } from '../../utils/logger';
import { ROLES } from '../../constants/roles';
import { Driver } from '../driver/driver.model';
import { Trip } from '../trip/trip.model';
import { Bus } from '../bus/bus.model';

const getMessage = (error: unknown): string =>
	error instanceof Error ? error.message : 'Something went wrong';

export const trackingController = {
	/**
	 * DEPRECATED: HTTP endpoint for single/batch location updates (legacy)
	 * Kept for backward compatibility - drivers should use POST /api/tracking/batch instead
	 */
	updateMyLocation: async (req: Request, res: Response): Promise<void> => {
		try {
			if (!req.user?.sub || !req.user.organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const body = req.body as {
				latitude?: number;
				longitude?: number;
				lat?: number;
				lng?: number;
				speed?: number;
				heading?: number;
				timestamp?: string;
				locations?: Array<{
					latitude?: number;
					longitude?: number;
					lat?: number;
					lng?: number;
					speed?: number;
					heading?: number;
					timestamp?: string;
				}>;
			};

			const items = Array.isArray(body.locations)
				? body.locations
				: [
					{
						latitude: body.latitude,
						longitude: body.longitude,
						lat: body.lat,
						lng: body.lng,
						speed: body.speed,
						heading: body.heading,
						timestamp: body.timestamp,
					},
				];

			if (items.length === 0) {
				res.status(400).json({ message: 'locations must contain at least one point' });
				return;
			}

			let location: Awaited<ReturnType<typeof trackingService.updateMyBusLocation>> | null = null;

			for (const item of items) {
				const latitude = typeof item.latitude === 'number' ? item.latitude : item.lat;
				const longitude = typeof item.longitude === 'number' ? item.longitude : item.lng;

				if (typeof latitude !== 'number' || typeof longitude !== 'number') {
					res.status(400).json({ message: 'latitude and longitude are required as numbers' });
					return;
				}

				if (typeof item.speed !== 'undefined' && typeof item.speed !== 'number') {
					res.status(400).json({ message: 'speed must be a number when provided' });
					return;
				}

				if (typeof item.heading !== 'undefined' && typeof item.heading !== 'number') {
					res.status(400).json({ message: 'heading must be a number when provided' });
					return;
				}

				let recordedAt: Date | undefined;
				if (typeof item.timestamp === 'string' && item.timestamp.trim().length > 0) {
					recordedAt = new Date(item.timestamp);
					if (Number.isNaN(recordedAt.getTime())) {
						res.status(400).json({ message: 'timestamp must be a valid ISO date string' });
						return;
					}
				}

				location = await trackingService.updateMyBusLocation(
					req.user.sub,
					req.user.organizationId,
					latitude,
					longitude,
					item.speed,
					recordedAt,
					item.heading
				);
			}

			if (!location) {
				res.status(400).json({ message: 'No location points were processed' });
				return;
			}

			res.status(200).json({ location });
		} catch (error) {
			const message = getMessage(error);
			const statusCode =
				message === 'Driver not found' ||
					message === 'No bus assigned to this driver' ||
					message === 'Assigned bus not found' ||
					message === 'No active trip found for this driver'
					? 404
					: 400;

			res.status(statusCode).json({ message });
		}
	},

	/**
	 * NEW: HTTP Batch Upload Endpoint (Production Architecture)
	 * 
	 * POST /api/tracking/batch
	 * 
	 * Request body:
	 * {
	 *   "tripId": "trip_123",
	 *   "driverId": "driver_123",
	 *   "busId": "bus_123",
	 *   "batchTimestamp": "2026-05-24T12:00:00Z",
	 *   "nonce": "unique_request_id_123",
	 *   "locations": [
	 *     {
	 *       "latitude": 17.385,
	 *       "longitude": 78.486,
	 *       "speed": 42,
	 *       "heading": 180,
	 *       "accuracy": 5,
	 *       "batteryLevel": 78,
	 *       "timestamp": "2026-05-24T12:00:00Z"
	 *     }
	 *   ]
	 * }
	 * 
	 * Features:
	 * - Batch location uploads (1-100 locations per request)
	 * - Replay attack prevention (nonce-based)
	 * - Rate limiting (10 batches per minute per driver)
	 * - Validation and spoofing detection
	 * - Redis caching for realtime access
	 * - Immediate passenger broadcast
	 * - Bulk database insert
	 */
	uploadBatch: async (req: Request, res: Response): Promise<void> => {
		try {
			if (!req.user?.sub || !req.user.organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			// Only drivers can upload batches
			if (req.user.role !== ROLES.DRIVER) {
				res.status(403).json({ message: 'Only drivers can upload location batches' });
				return;
			}

			// Validate batch request
			const validation = await batchTrackingService.validateBatchRequest(req.body);
			if (!validation.isValid) {
				res.status(400).json({ message: validation.error || 'Invalid batch request' });
				return;
			}

			const payload = validation.validated!;

			// Short trace log when batch upload is received
			console.log('[BATCH UPLOAD RECEIVED]', { driverId: payload.driverId, busId: payload.busId, tripId: payload.tripId, locations: payload.locations.length });

			// Verify driverId matches JWT
			if (payload.driverId !== req.user.sub) {
				logger.warn(
					`Driver ID mismatch: JWT=${req.user.sub}, payload=${payload.driverId}`
				);
				res.status(403).json({ message: 'Driver ID does not match authentication token' });
				return;
			}

			// Check rate limit
			const rateLimit = await batchTrackingService.checkRateLimit(req.user.sub);
			if (!rateLimit.allowed) {
				res.status(429).json({
					message: 'Rate limit exceeded (max 10 batches per minute)',
					remaining: 0,
					resetIn: rateLimit.resetIn,
				});
				return;
			}

			// Process batch
			const result = await batchTrackingService.processBatch(req.user.organizationId, payload);

			if (!result.success) {
				res.status(400).json({
					success: false,
					message: result.errors?.[0] || 'Batch processing failed',
					details: {
						validCount: result.validCount,
						invalidCount: result.invalidCount,
						duplicateCount: result.duplicateCount,
						errors: result.errors,
					},
				});
				return;
			}

			res.status(200).json({
				success: true,
				processedCount: result.processedCount,
				validCount: result.validCount,
				invalidCount: result.invalidCount,
				duplicateCount: result.duplicateCount,
				cacheUpdated: result.cacheUpdated,
				rateLimit: {
					remaining: rateLimit.remaining,
					resetIn: rateLimit.resetIn,
				},
				nextExpectedBatch: new Date(Date.now() + 15000).toISOString(),  // 15 seconds
			});
		} catch (error) {
			logger.error(`Batch upload error: ${getMessage(error)}`);
			res.status(500).json({
				success: false,
				message: 'Internal server error during batch processing',
			});
		}
	},

	/**
	 * GET: Retrieve current cached driver location
	 * GET /api/tracking/driver/:driverId/location
	 * SECURITY: Verifies driverId belongs to the requesting user's organization
	 */
	getDriverLocation: async (req: Request, res: Response): Promise<void> => {
		try {
			if (!req.user?.sub || !req.user.organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const driverId = Array.isArray(req.params.driverId) ? req.params.driverId[0] : req.params.driverId;

			if (!driverId) {
				res.status(400).json({ message: 'driverId is required' });
				return;
			}

			// SECURITY: Verify driverId belongs to the requesting user's organization
			const driverExists = await Driver.exists({
				_id: driverId,
				organizationId: req.user.organizationId,
			});
			if (!driverExists) {
				res.status(404).json({ message: 'Driver not found' });
				return;
			}

			// Get from cache
			const location = await batchTrackingService.getDriverLocationCache(driverId);

			if (!location) {
				// Try to get latest from DB if not in cache
				const lastLog = await trackingService.getLastDriverLocation(driverId);
				if (!lastLog) {
					res.status(404).json({ message: 'No location found for driver' });
					return;
				}

				res.status(200).json({
					source: 'database',
					driverId,
					latitude: lastLog.latitude,
					longitude: lastLog.longitude,
					speed: lastLog.speed || 0,
					heading: lastLog.heading || 0,
					accuracy: lastLog.accuracy,
					timestamp: lastLog.timestamp.toISOString(),
					recordedAt: lastLog.recordedAt.toISOString(),
				});
				return;
			}

			res.status(200).json({
				source: 'cache',
				driverId,
				...location,
			});
		} catch (error) {
			const message = getMessage(error);
			logger.error(`Get driver location error: ${message}`);
			res.status(500).json({ message: 'Failed to retrieve driver location' });
		}
	},

	/**
	 * GET: Retrieve current cached trip location (latest bus location)
	 * GET /api/tracking/trip/:tripId/location
	 * SECURITY: Verifies tripId belongs to the requesting user's organization
	 */
	getTripLocation: async (req: Request, res: Response): Promise<void> => {
		try {
			if (!req.user?.sub || !req.user.organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const tripId = Array.isArray(req.params.tripId) ? req.params.tripId[0] : req.params.tripId;

			if (!tripId) {
				res.status(400).json({ message: 'tripId is required' });
				return;
			}

			// SECURITY: Verify tripId belongs to the requesting user's organization
			const tripExists = await Trip.exists({
				_id: tripId,
				organizationId: req.user.organizationId,
			});
			if (!tripExists) {
				res.status(404).json({ message: 'Trip not found' });
				return;
			}

			// Get from cache
			const location = await batchTrackingService.getTripLocationCache(tripId);

			if (!location) {
				// Try to get latest from DB if not in cache
				const lastLog = await trackingService.getLastTripLocation(tripId);
				if (!lastLog) {
					res.status(404).json({ message: 'No location found for trip' });
					return;
				}

				res.status(200).json({
					source: 'database',
					tripId,
					latitude: lastLog.latitude,
					longitude: lastLog.longitude,
					speed: lastLog.speed || 0,
					heading: lastLog.heading || 0,
					accuracy: lastLog.accuracy,
					timestamp: lastLog.timestamp.toISOString(),
				});
				return;
			}

			res.status(200).json({
				source: 'cache',
				tripId,
				...location,
			});
		} catch (error) {
			const message = getMessage(error);
			logger.error(`Get trip location error: ${message}`);
			res.status(500).json({ message: 'Failed to retrieve trip location' });
		}
	},

	/**
	 * GET: Retrieve current cached bus location
	 * GET /api/tracking/bus/:busId/location
	 * SECURITY: Verifies busId belongs to the requesting user's organization
	 */
	getBusLocation: async (req: Request, res: Response): Promise<void> => {
		try {
			if (!req.user?.sub || !req.user.organizationId) {
				res.status(401).json({ message: 'Unauthorized' });
				return;
			}

			const busId = Array.isArray(req.params.busId) ? req.params.busId[0] : req.params.busId;

			if (!busId) {
				res.status(400).json({ message: 'busId is required' });
				return;
			}

			// SECURITY: Verify busId belongs to the requesting user's organization
			const busExists = await Bus.exists({
				_id: busId,
				organizationId: req.user.organizationId,
			});
			if (!busExists) {
				res.status(404).json({ message: 'Bus not found' });
				return;
			}

			// Get from cache
			const location = await batchTrackingService.getBusLocationCache(busId);

			if (!location) {
				// Try to get latest from DB if not in cache
				const lastLog = await trackingService.getLastBusLocation(busId);
				if (!lastLog) {
					res.status(404).json({ message: 'No location found for bus' });
					return;
				}

				res.status(200).json({
					source: 'database',
					busId,
					latitude: lastLog.latitude,
					longitude: lastLog.longitude,
					speed: lastLog.speed || 0,
					heading: lastLog.heading || 0,
					accuracy: lastLog.accuracy,
					timestamp: lastLog.timestamp.toISOString(),
				});
				return;
			}

			res.status(200).json({
				source: 'cache',
				busId,
				...location,
			});
		} catch (error) {
			const message = getMessage(error);
			logger.error(`Get bus location error: ${message}`);
			res.status(500).json({ message: 'Failed to retrieve bus location' });
		}
	},
};
