# HTTP Batch Upload API - Driver App Integration Guide

## Overview

Drivers upload GPS locations via **HTTP POST requests** instead of WebSocket. This approach is:
- ✅ Battery efficient (no persistent connections)
- ✅ Works in iOS/Android background mode  
- ✅ Scalable (stateless HTTP)
- ✅ Reliable (automatic retries)
- ✅ Secure (JWT + nonce-based replay prevention)

---

## Endpoint

**POST** `/api/tracking/batch`

**Base URL**: `https://api.where-you-are.com` (production)

**Authentication**: JWT Bearer token (driver role)

---

## Request Headers

```
Content-Type: application/json
Authorization: Bearer <JWT_TOKEN>
```

**JWT Token Structure** (issued at driver login):
```json
{
  "sub": "driver_id_123",
  "organizationId": "org_id_456",
  "role": "driver",
  "iat": 1622000000,
  "exp": 1622604800
}
```

---

## Request Body

```typescript
interface BatchUploadRequest {
  // Trip being tracked
  tripId: string;                // MongoDB ObjectId or UUID
  
  // Driver identification (must match JWT)
  driverId: string;              // Must match JWT subject claim
  
  // Bus assignment
  busId: string;                 // MongoDB ObjectId or UUID
  
  // Batch timing
  batchTimestamp: string;        // ISO 8601: "2026-05-24T12:00:15Z"
  
  // Replay attack prevention (REQUIRED)
  nonce: string;                 // UUID v4, unique per request
  
  // Location data points
  locations: LocationPoint[];    // 1-100 points per batch
}

interface LocationPoint {
  latitude: number;              // -90 to 90
  longitude: number;             // -180 to 180
  timestamp: string;             // ISO 8601
  
  // Optional
  speed?: number;                // m/s (0+)
  heading?: number;              // degrees 0-360
  accuracy?: number;             // meters (0+)
  batteryLevel?: number;         // percent (0-100)
}
```

---

## Example Requests

### Single Location
```bash
curl -X POST https://api.where-you-are.com/api/tracking/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d '{
    "tripId": "507f1f77bcf86cd799439011",
    "driverId": "507f1f77bcf86cd799439012",
    "busId": "507f1f77bcf86cd799439013",
    "batchTimestamp": "2026-05-24T12:00:15Z",
    "nonce": "550e8400-e29b-41d4-a716-446655440000",
    "locations": [
      {
        "latitude": 17.385,
        "longitude": 78.486,
        "timestamp": "2026-05-24T12:00:15Z",
        "speed": 42,
        "heading": 180,
        "accuracy": 5,
        "batteryLevel": 78
      }
    ]
  }'
```

### Batch (10 Locations)
```json
{
  "tripId": "507f1f77bcf86cd799439011",
  "driverId": "507f1f77bcf86cd799439012",
  "busId": "507f1f77bcf86cd799439013",
  "batchTimestamp": "2026-05-24T12:00:30Z",
  "nonce": "550e8400-e29b-41d4-a716-446655440001",
  "locations": [
    {
      "latitude": 17.3850,
      "longitude": 78.4860,
      "timestamp": "2026-05-24T12:00:02Z",
      "speed": 40,
      "heading": 175,
      "accuracy": 5,
      "batteryLevel": 80
    },
    {
      "latitude": 17.3851,
      "longitude": 78.4861,
      "timestamp": "2026-05-24T12:00:05Z",
      "speed": 42,
      "heading": 178,
      "accuracy": 4,
      "batteryLevel": 79
    },
    // ... more locations ...
    {
      "latitude": 17.3857,
      "longitude": 78.4867,
      "timestamp": "2026-05-24T12:00:30Z",
      "speed": 45,
      "heading": 180,
      "accuracy": 5,
      "batteryLevel": 78
    }
  ]
}
```

---

## Success Response (200 OK)

```json
{
  "success": true,
  "processedCount": 10,
  "validCount": 10,
  "invalidCount": 0,
  "duplicateCount": 0,
  "cacheUpdated": true,
  "rateLimit": {
    "remaining": 8,
    "resetIn": 60
  },
  "nextExpectedBatch": "2026-05-24T12:00:45Z"
}
```

**Fields**:
- `processedCount`: Locations saved to database
- `validCount`: Passed validation
- `invalidCount`: Failed validation
- `duplicateCount`: Exact duplicates (skipped)
- `cacheUpdated`: Redis cache updated for realtime broadcast
- `rateLimit.remaining`: Batches allowed before limit
- `rateLimit.resetIn`: Seconds until rate limit resets
- `nextExpectedBatch`: Recommended time for next batch

---

## Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "message": "Error description",
  "details": {
    "validCount": 8,
    "invalidCount": 2,
    "duplicateCount": 0,
    "errors": [
      "Latitude out of bounds at index 1",
      "Invalid timestamp at index 5"
    ]
  }
}
```

### 401 Unauthorized
```json
{
  "message": "Unauthorized"
}
```
**Cause**: Missing or invalid JWT token

### 403 Forbidden
```json
{
  "message": "Only drivers can upload location batches"
}
```
**Cause**: Non-driver role trying to upload

### 429 Too Many Requests
```json
{
  "message": "Rate limit exceeded (max 10 batches per minute)",
  "remaining": 0,
  "resetIn": 45
}
```
**Cause**: Exceeded 10 batches per minute. Wait 45 seconds.

---

## Validation Rules

### Coordinates
- Latitude: `-90.0` to `90.0`
- Longitude: `-180.0` to `180.0`

### Speed
- Value: `0` to `unlimited` m/s
- ⚠️ > 41.67 m/s (150 km/h) logged as suspicious but accepted
- ⚠️ Unrealistic jumps rejected (spoofing detection)

### Heading
- Value: `0` to `360` degrees
- `0°` = North, `90°` = East, `180°` = South, `270°` = West

### Timestamp
- Format: ISO 8601 (`"2026-05-24T12:00:00Z"`)
- Cannot be > 30 seconds in future (clock skew tolerance)
- Cannot be > 24 hours in past
- Must be increasing (newer than previous)

### Accuracy
- Value: `0` to `unlimited` meters
- < 5m = excellent GPS fix
- 5-20m = good
- 20-100m = acceptable
- > 100m = low confidence

---

## Implementation Guide

### Driver App (Pseudocode)

```javascript
class LocationBatcher {
  constructor(tripId, driverId, busId) {
    this.tripId = tripId;
    this.driverId = driverId;
    this.busId = busId;
    this.locations = [];
    this.uploadInterval = 15000;  // 15 seconds
    this.maxLocations = 50;       // Max 50 per batch
    
    // Start background task
    this.startBackgroundTracking();
  }

  async startBackgroundTracking() {
    while (this.isTracking) {
      try {
        // Collect GPS locations
        const gpsData = await this.getGPSLocation();
        
        if (gpsData) {
          this.locations.push({
            latitude: gpsData.lat,
            longitude: gpsData.lng,
            timestamp: new Date().toISOString(),
            speed: gpsData.speed,
            heading: gpsData.heading,
            accuracy: gpsData.accuracy,
            batteryLevel: await this.getBatteryLevel()
          });
        }
        
        // Upload batch when ready
        if (this.locations.length >= this.maxLocations || 
            this.timeSinceLastUpload >= this.uploadInterval) {
          await this.uploadBatch();
        }
      } catch (error) {
        console.error('Tracking error:', error);
        // Retry logic handled below
      }
      
      // Wait 5 seconds before next collection
      await this.sleep(5000);
    }
  }

  async uploadBatch() {
    if (this.locations.length === 0) {
      return;
    }

    const payload = {
      tripId: this.tripId,
      driverId: this.driverId,
      busId: this.busId,
      batchTimestamp: new Date().toISOString(),
      nonce: this.generateUUID(),
      locations: [...this.locations]  // Clone before clearing
    };

    try {
      const response = await this.request(
        'POST',
        '/api/tracking/batch',
        payload
      );

      if (response.success) {
        console.log(`Uploaded ${response.processedCount} locations`);
        this.locations = [];  // Clear only after success
        this.lastUploadTime = Date.now();
      } else {
        console.warn(`Upload failed: ${response.message}`);
        // Retry next cycle
      }
    } catch (error) {
      console.error('Upload error:', error);
      // Retry with exponential backoff
      await this.retryWithBackoff(payload);
    }
  }

  async retryWithBackoff(payload) {
    let delay = 1000;  // Start with 1 second
    
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.sleep(delay);
        const response = await this.request('POST', '/api/tracking/batch', payload);
        if (response.success) {
          this.locations = [];
          return;
        }
      } catch (error) {
        if (attempt < 5) {
          delay *= 2;  // Double delay for next attempt
          console.log(`Retry ${attempt}: waiting ${delay}ms`);
        }
      }
    }
    
    // After 5 failed retries, wait for next cycle
    console.error('Upload failed after 5 retries. Will retry next cycle.');
  }

  async request(method, path, data) {
    const jwtToken = await this.getJWTToken();
    
    const response = await fetch(`https://api.where-you-are.com${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      },
      body: JSON.stringify(data)
    });

    if (response.status === 429) {
      const data = await response.json();
      console.warn(`Rate limited. Reset in ${data.resetIn}s`);
      throw new Error('Rate limited');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### React Native Example

```typescript
import * as Location from 'expo-location';
import { v4 as uuidv4 } from 'uuid';
import * as Battery from 'expo-battery';

class LocationTracker {
  private tripId: string;
  private driverId: string;
  private busId: string;
  private jwtToken: string;
  private locationWatcher: Location.LocationSubscription | null = null;
  private uploadTimer: NodeJS.Timeout | null = null;
  private locations: LocationPoint[] = [];

  constructor(tripId: string, driverId: string, busId: string, jwtToken: string) {
    this.tripId = tripId;
    this.driverId = driverId;
    this.busId = busId;
    this.jwtToken = jwtToken;
  }

  async startTracking() {
    // Request permissions
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Location permission denied');
    }

    // High-accuracy background tracking
    await Location.startLocationUpdatesAsync(
      'LOCATION_TRACKING_TASK',  // Background task name
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 5000,  // Update every 5 seconds
        distanceInterval: 0,
        showsBackgroundLocationIndicator: true,
      }
    );

    // Start upload timer (15 seconds)
    this.uploadTimer = setInterval(() => this.uploadBatch(), 15000);
  }

  async stopTracking() {
    if (this.locationWatcher) {
      this.locationWatcher.remove();
    }
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer);
    }
    
    // Final upload
    await this.uploadBatch();
  }

  async collectLocation() {
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    const battery = await Battery.getBatteryLevelAsync();

    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      speed: location.coords.speed || 0,
      heading: location.coords.heading || 0,
      accuracy: location.coords.accuracy || 0,
      timestamp: new Date().toISOString(),
      batteryLevel: Math.round(battery * 100),
    };
  }

  private async uploadBatch() {
    if (this.locations.length === 0) {
      return;
    }

    const payload = {
      tripId: this.tripId,
      driverId: this.driverId,
      busId: this.busId,
      batchTimestamp: new Date().toISOString(),
      nonce: uuidv4(),
      locations: this.locations,
    };

    try {
      const response = await fetch(
        'https://api.where-you-are.com/api/tracking/batch',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.jwtToken}`,
          },
          body: JSON.stringify(payload),
        }
      );

      if (response.status === 429) {
        console.warn('Rate limited');
        return;  // Retry next cycle
      }

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          console.log(`✓ Uploaded ${data.processedCount} locations`);
          this.locations = [];  // Clear after success
        }
      }
    } catch (error) {
      console.error('Upload failed:', error);
      // Retry in next cycle
    }
  }
}

// Usage
const tracker = new LocationTracker(
  'trip_123',
  'driver_456',
  'bus_789',
  jwtToken
);

// Start tracking when trip starts
await tracker.startTracking();

// Stop when trip ends
await tracker.stopTracking();
```

---

## Best Practices

### 1. Batch Collection
```
- Collect locations every 5 seconds
- Upload batch every 15 seconds
- This gives 3 locations per batch (minimal overhead)
```

### 2. Nonce Generation
```
- Generate unique UUID v4 for each request
- Never reuse nonce
- Server rejects duplicate nonce (replay attack)
```

### 3. Error Handling
```
- Return 400: Validation failed (fix data)
- Return 401: JWT expired (refresh token)
- Return 403: Permission denied (check role)
- Return 429: Rate limited (wait & retry)
- Return 5xx: Server error (retry later)
```

### 4. Retry Strategy
```
- Exponential backoff: 1s, 2s, 4s, 8s, 16s
- Maximum 5 retries per batch
- After 5 failures, discard batch
- Next batch will be collected next cycle
```

### 5. Battery Optimization
```
- Use high-accuracy GPS (better location, less retries)
- Batch requests (15s intervals vs 1s)
- Use native background APIs (not WebSocket)
- No persistent connections
- Result: <2% battery drain per hour
```

### 6. Network Conditions
```
- GZIP request body for mobile bandwidth
- Implement exponential backoff
- Handle offline gracefully (queue locally)
- Resume when network returns
```

---

## Monitoring

### Driver App Should Log
```
- GPS location collected
- Batch prepared (location count)
- Upload attempt (timestamp, nonce)
- Upload success/failure
- Rate limit hits
- Battery level at time of upload
```

### Backend Will Monitor
```
- Batch upload latency
- Location validation success rate
- Duplicate count
- Spoofing detection triggers
- Database insert performance
- Redis cache updates
```

---

## Troubleshooting

### Q: Upload fails with 401 Unauthorized
**A**: JWT token expired. Call `/api/auth/refresh` to get new token.

### Q: Upload fails with 403 Forbidden
**A**: User is not a driver. Check JWT role claim.

### Q: Upload fails with 429 Too Many Requests
**A**: Exceeded 10 batches per minute. Wait for rate limit to reset.

### Q: Locations missing or delayed
**A**: Check network connectivity. Implement retry logic. Verify batch upload is succeeding.

### Q: Battery draining fast
**A**: Verify not using WebSocket. Check GPS accuracy settings. Verify batch intervals (should be 15s).

### Q: GPS coordinates jumping/unrealistic
**A**: Normal for low GPS accuracy. Server filters suspicious movements (>150 km/h). Check device GPS settings.

---

## Reference

- **Rate Limit**: 10 batches/minute per driver
- **Max Locations**: 100 per batch
- **Recommended Interval**: 15 seconds
- **Cache TTL**: 30 seconds
- **Replay Prevention**: 1-hour nonce TTL
