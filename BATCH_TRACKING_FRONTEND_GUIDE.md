# Batch Tracking API Integration Guide

Complete step-by-step guide to integrate `POST /api/tracking/batch` in your frontend.

---

## Architecture Overview

```
Mobile App (Driver)
    ↓
1. Collect locations (every 2-5 seconds via GPS)
    ↓
2. Store in local queue/array
    ↓
3. Every 15 seconds → Package into batch
    ↓
4. Send batch to /api/tracking/batch
    ↓
5. Backend: Save to DB + Redis + Broadcast to passengers
```

---

## Step 1: Create Location Tracking Service

Create `services/locationTrackingService.ts` (or `.js`):

```typescript
import { getAuthToken } from './authService'; // Your auth method

interface LocationData {
    latitude: number;
    longitude: number;
    timestamp: string;
    speed?: number;
    heading?: number;
    accuracy?: number;
    batteryLevel?: number;
}

interface BatchPayload {
    tripId: string;
    driverId: string;
    busId: string;
    batchTimestamp: string;
    nonce: string;
    locations: LocationData[];
}

class LocationTrackingService {
    private locationQueue: LocationData[] = [];
    private tripContext: {
        tripId: string;
        driverId: string;
        busId: string;
    } | null = null;

    private locationWatchId: number | null = null;
    private syncIntervalId: NodeJS.Timer | null = null;
    private isTracking = false;

    /**
     * START TRACKING
     * Call this when trip starts (driver presses "Start Trip" button)
     */
    async startTracking(tripId: string, driverId: string, busId: string) {
        console.log('🔴 [useDriverTracking.startTracking] CALLED with:', {
            tripId,
            driverId,
            busId,
            isDefined: {
                hasDriverId: !!driverId,
                hasBusId: !!busId,
                hasTripId: !!tripId
            }
        });

        if (!tripId || !driverId || !busId) {
            throw new Error('tripId, driverId, and busId are required');
        }

        this.tripContext = { tripId, driverId, busId };
        this.isTracking = true;
        this.locationQueue = [];

        // Start collecting locations
        this.startLocationCollection();

        // Start batching every 15 seconds
        this.startBatchSync();

        console.log('✅ Tracking started');
    }

    /**
     * STOP TRACKING
     * Call this when trip ends
     */
    async stopTracking() {
        console.log('⛔ Stopping tracking...');

        this.isTracking = false;

        // Stop collecting locations
        if (this.locationWatchId !== null) {
            navigator.geolocation.clearWatch(this.locationWatchId);
            this.locationWatchId = null;
        }

        // Stop batching
        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }

        // Send any remaining locations
        if (this.locationQueue.length > 0) {
            await this.uploadBatch();
        }

        this.tripContext = null;
        this.locationQueue = [];

        console.log('✅ Tracking stopped');
    }

    /**
     * STEP 1: Collect GPS locations every 2-5 seconds
     */
    private startLocationCollection() {
        console.log('📍 Starting location collection...');

        const options = {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        };

        this.locationWatchId = navigator.geolocation.watchPosition(
            (position) => {
                const { latitude, longitude, accuracy } = position.coords;
                const speed = position.coords.speed || 0;
                const heading = position.coords.heading || 0;

                const location: LocationData = {
                    latitude,
                    longitude,
                    speed,
                    heading,
                    accuracy,
                    timestamp: new Date().toISOString(),
                };

                this.locationQueue.push(location);

                console.log(`📌 Location collected (queue size: ${this.locationQueue.length})`);
            },
            (error) => {
                console.error('❌ Geolocation error:', error);
            },
            options
        );
    }

    /**
     * STEP 2: Batch locations every 15 seconds
     */
    private startBatchSync() {
        console.log('⏱️  Starting batch sync (every 15 seconds)...');

        // First sync after 15 seconds
        this.syncIntervalId = setInterval(() => {
            this.performSync();
        }, 15000); // 15 seconds
    }

    private async performSync() {
        if (!this.isTracking || !this.tripContext) {
            return;
        }

        console.log(`🔄 Sync cycle {
            queueSize: ${this.locationQueue.length},
            hasAuth: ${!!getAuthToken()},
            hasTripId: ${!!this.tripContext.tripId},
            hasDriverId: ${!!this.tripContext.driverId},
            hasBusId: ${!!this.tripContext.busId}
        }`);

        // Don't upload if no locations
        if (this.locationQueue.length === 0) {
            console.log('⏭️  No locations to upload, skipping');
            return;
        }

        // Don't upload if missing auth or trip context
        if (!getAuthToken() || !this.tripContext.tripId) {
            console.warn('⚠️  Missing auth or trip context, will retry');
            return;
        }

        try {
            await this.uploadBatch();
        } catch (error) {
            console.error('❌ Batch upload failed:', error);
            // Locations remain in queue for retry on next cycle
        }
    }

    /**
     * STEP 3: Upload batch to backend
     */
    private async uploadBatch() {
        if (!this.tripContext || this.locationQueue.length === 0) {
            return;
        }

        const token = getAuthToken();
        if (!token) {
            throw new Error('No auth token available');
        }

        const payload: BatchPayload = {
            tripId: this.tripContext.tripId,
            driverId: this.tripContext.driverId,
            busId: this.tripContext.busId,
            batchTimestamp: new Date().toISOString(),
            nonce: this.generateNonce(), // Unique ID for each batch
            locations: [...this.locationQueue] // Copy array
        };

        try {
            console.log(`📤 Uploading ${payload.locations.length} locations...`);

            const response = await fetch('https://your-backend.com/api/tracking/batch', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || `HTTP ${response.status}`);
            }

            const result = await response.json();

            console.log('✅ Batch uploaded successfully:', {
                processedCount: result.processedCount,
                validCount: result.validCount,
                duplicateCount: result.duplicateCount,
                rateLimit: result.rateLimit,
            });

            // Clear queue only after successful upload
            this.locationQueue = [];

        } catch (error) {
            console.error('❌ Batch upload failed:', error);
            // DO NOT clear queue - retry on next cycle
            throw error;
        }
    }

    /**
     * Generate unique nonce for replay attack prevention
     */
    private generateNonce(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get current tracking status
     */
    getStatus() {
        return {
            isTracking: this.isTracking,
            queueSize: this.locationQueue.length,
            tripContext: this.tripContext,
        };
    }
}

export const locationTrackingService = new LocationTrackingService();
```

---

## Step 2: Create Auth Service

Create `services/authService.ts`:

```typescript
let authToken: string | null = null;
let userId: string | null = null;
let tripContext: { driverId: string; organizationId: string } | null = null;

/**
 * Store token after login
 */
export const setAuthToken = (token: string, driverId: string, organizationId: string) => {
    authToken = token;
    userId = driverId;
    tripContext = { driverId, organizationId };
    localStorage.setItem('authToken', token);
};

/**
 * Get stored token
 */
export const getAuthToken = (): string | null => {
    if (authToken) return authToken;
    
    // Fallback: check localStorage
    authToken = localStorage.getItem('authToken');
    return authToken;
};

/**
 * Clear token on logout
 */
export const clearAuthToken = () => {
    authToken = null;
    userId = null;
    tripContext = null;
    localStorage.removeItem('authToken');
};

/**
 * Get driver context
 */
export const getDriverContext = () => {
    return { userId, tripContext };
};
```

---

## Step 3: Hook Integration (React/React Native)

Create `hooks/useDriverTracking.ts`:

```typescript
import { useState, useCallback, useRef } from 'react';
import { locationTrackingService } from '../services/locationTrackingService';
import { getAuthToken } from '../services/authService';

export const useDriverTracking = () => {
    const [isTracking, setIsTracking] = useState(false);
    const [queueSize, setQueueSize] = useState(0);
    const statusIntervalRef = useRef<NodeJS.Timer | null>(null);

    const startTracking = useCallback(async (tripId: string, driverId: string, busId: string) => {
        try {
            console.log('🎬 Starting tracking with:', { tripId, driverId, busId });

            if (!getAuthToken()) {
                throw new Error('Not authenticated');
            }

            await locationTrackingService.startTracking(tripId, driverId, busId);
            setIsTracking(true);

            // Update queue size every 5 seconds for UI
            if (statusIntervalRef.current) {
                clearInterval(statusIntervalRef.current);
            }
            statusIntervalRef.current = setInterval(() => {
                const status = locationTrackingService.getStatus();
                setQueueSize(status.queueSize);
            }, 5000);

        } catch (error) {
            console.error('❌ Failed to start tracking:', error);
            throw error;
        }
    }, []);

    const stopTracking = useCallback(async () => {
        try {
            console.log('🛑 Stopping tracking');

            if (statusIntervalRef.current) {
                clearInterval(statusIntervalRef.current);
            }

            await locationTrackingService.stopTracking();
            setIsTracking(false);
            setQueueSize(0);

        } catch (error) {
            console.error('❌ Failed to stop tracking:', error);
            throw error;
        }
    }, []);

    return {
        isTracking,
        queueSize,
        startTracking,
        stopTracking,
    };
};
```

---

## Step 4: Component Usage

When driver starts a trip:

```typescript
import { useDriverTracking } from '../hooks/useDriverTracking';
import { useTrip } from '../hooks/useTrip';
import { useAuth } from '../hooks/useAuth';

export function TripStartButton() {
    const { trip, startTrip } = useTrip();
    const { user } = useAuth(); // Get driverId
    const { isTracking, queueSize, startTracking, stopTracking } = useDriverTracking();

    const handleStartTrip = async () => {
        try {
            // 1. Create trip on backend
            const newTrip = await startTrip();

            // 2. Start tracking with trip details
            await startTracking(
                newTrip._id,           // tripId
                user._id,              // driverId
                user.assignedBusId     // busId
            );

            console.log('✅ Trip started and tracking enabled');

        } catch (error) {
            console.error('❌ Failed to start trip:', error);
        }
    };

    const handleEndTrip = async () => {
        try {
            // 1. Stop tracking
            await stopTracking();

            // 2. End trip on backend
            await trip.endTrip();

            console.log('✅ Trip ended');

        } catch (error) {
            console.error('❌ Failed to end trip:', error);
        }
    };

    return (
        <div>
            <button onClick={handleStartTrip} disabled={isTracking}>
                Start Trip
            </button>
            <button onClick={handleEndTrip} disabled={!isTracking}>
                End Trip
            </button>
            {isTracking && (
                <div>
                    🟢 Tracking Active
                    <br />
                    Locations queued: {queueSize}
                </div>
            )}
        </div>
    );
}
```

---

## Step 5: Battery & Permission Setup

Add to your app initialization:

```typescript
// Request permissions (React Native example)
import { PermissionsAndroid } from 'react-native';

export const requestLocationPermissions = async () => {
    try {
        const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            {
                title: 'Location Permission',
                message: 'We need access to your location for tracking',
                buttonNeutral: 'Ask Me Later',
                buttonNegative: 'Cancel',
                buttonPositive: 'OK',
            },
        );

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
            console.log('✅ Location permission granted');
            return true;
        } else {
            console.warn('❌ Location permission denied');
            return false;
        }
    } catch (err) {
        console.warn('Permission error:', err);
        return false;
    }
};
```

---

## Step 6: Backend API Integration Checklist

✅ **API Endpoint:** `POST /api/tracking/batch`

✅ **Required Headers:**
```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

✅ **Request Body:**
```json
{
    "tripId": "trip_123",
    "driverId": "driver_123",
    "busId": "bus_123",
    "batchTimestamp": "2026-05-26T12:00:00Z",
    "nonce": "1234567890-abc123",
    "locations": [
        {
            "latitude": 17.385,
            "longitude": 78.486,
            "speed": 42,
            "heading": 180,
            "accuracy": 5,
            "timestamp": "2026-05-26T12:00:00Z"
        }
    ]
}
```

✅ **Success Response (200):**
```json
{
    "success": true,
    "processedCount": 45,
    "validCount": 45,
    "duplicateCount": 0,
    "cacheUpdated": true,
    "rateLimit": {
        "remaining": 9,
        "resetIn": 60
    }
}
```

✅ **Error Responses:**
- `400` - Invalid request (missing fields, invalid coords)
- `401` - Unauthorized (no token or expired)
- `403` - Forbidden (driver mismatch, not assigned to bus)
- `429` - Rate limited (10 batches/minute exceeded)

---

## Step 7: Testing Checklist

Before deploying:

```
☐ Request geolocation permissions
☐ Start trip → Should see "🔴 [useDriverTracking.startTracking] CALLED" in console
☐ Wait 15 seconds → Should see "📤 Uploading X locations..." 
☐ Check backend logs → Should see "✅ Redis caching completed"
☐ Verify battery level is included in batch
☐ Test with 0 locations in queue → Should not send empty batch
☐ Test with 150 locations → Should fail with "locations array cannot exceed 100"
☐ Test nonce uniqueness → Each batch should have different nonce
☐ Test network failure → Locations should remain in queue and retry
```

---

## Step 8: Environment Variables

Add to your frontend `.env`:

```env
REACT_APP_API_URL=https://your-backend.com
REACT_APP_TRACKING_INTERVAL_MS=15000
REACT_APP_LOCATION_INTERVAL_MS=5000
```

---

## Debugging Commands

**Check current tracking status:**
```javascript
locationTrackingService.getStatus()
// Output: { isTracking: true, queueSize: 28, tripContext: {...} }
```

**Manually trigger batch upload:**
```javascript
// In browser console after starting tracking
await locationTrackingService.uploadBatch()
```

**Clear queued locations:**
```javascript
locationTrackingService.locationQueue = []
```

---

## Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Tracking starts but no uploads | `driverId/busId/tripId` undefined | Verify `startTracking()` is called with correct values |
| Locations not collected | Geolocation permission denied | Request `ACCESS_FINE_LOCATION` permission |
| Batch upload fails with 403 | `driverId` in JWT ≠ `driverId` in payload | Ensure driver is logged in correctly |
| Rate limit error (429) | Sending >10 batches/minute | Check interval is 15+ seconds |
| Empty queue after 15 seconds | GPS not working in background | Check location collection is running |
| Nonce error | Sending duplicate nonce | Ensure `generateNonce()` uses Date.now() |

---

## Notes

1. **Background Tracking:** For React Native, you'll need `react-native-background-geolocation` or similar plugin
2. **Permissions:** Always request permissions before starting `startTracking()`
3. **Battery:** Monitor battery during active tracking
4. **Network:** Service retries automatically on network failure
5. **Timestamps:** Always use ISO string format: `new Date().toISOString()`
6. **Nonce:** Must be unique per batch to prevent replay attacks

---

**Ready to integrate? Start with Step 1 and work through each step. Share console logs if you hit any issues!** 🚀
