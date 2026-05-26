# Redis Integration Guide for Mobile Driver App

## Overview

Your backend now caches driver locations in **Redis Cloud** for fast realtime access. Your mobile app needs to:
1. Collect location data locally
2. **Batch** them every 15 seconds
3. Send to `/api/tracking/batch` endpoint
4. Backend will cache to Redis automatically

---

## Architecture Flow

```
Mobile App (Driver)
    ↓
Collect locations (every 2-5 sec)
    ↓
Buffer in local array
    ↓
Every 15 seconds → Send batch to /api/tracking/batch
    ↓
Backend validates + saves to MongoDB
    ↓
Backend caches latest location to Redis ✅
    ↓
Real-time broadcast to passengers via Socket.IO
```

---

## 1. Batch Tracking Service Setup

### Create Service: `trackingService.ts` (or `.js`)

```typescript
// services/trackingService.ts

interface LocationData {
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  accuracy?: number;
  batteryLevel?: number;
  timestamp: string;
}

interface BatchPayload {
  tripId: string;
  driverId: string;
  busId: string;
  batchTimestamp: string;
  nonce: string;
  locations: LocationData[];
}

class TrackingService {
  private locationBuffer: LocationData[] = [];
  private batchInterval: NodeJS.Timeout | null = null;
  private apiBaseUrl: string;
  private authToken: string = '';
  
  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
  }

  /**
   * Set authentication token
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Add a single location to buffer
   */
  addLocation(location: LocationData): void {
    // Prevent buffer overflow (keep last 100 locations)
    if (this.locationBuffer.length >= 100) {
      this.locationBuffer.shift();
    }
    this.locationBuffer.push(location);
  }

  /**
   * Start batching (call once when trip starts)
   */
  startBatching(tripId: string, driverId: string, busId: string): void {
    if (this.batchInterval) {
      return; // Already batching
    }

    this.batchInterval = setInterval(() => {
      this.sendBatch(tripId, driverId, busId);
    }, 15000); // Send every 15 seconds
  }

  /**
   * Stop batching (call when trip ends)
   */
  stopBatching(): void {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
  }

  /**
   * Send batch to backend
   */
  private async sendBatch(
    tripId: string,
    driverId: string,
    busId: string
  ): Promise<void> {
    // Don't send empty batches
    if (this.locationBuffer.length === 0) {
      return;
    }

    try {
      const payload: BatchPayload = {
        tripId,
        driverId,
        busId,
        batchTimestamp: new Date().toISOString(),
        nonce: this.generateNonce(),
        locations: [...this.locationBuffer],
      };

      const response = await fetch(`${this.apiBaseUrl}/api/tracking/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error('Batch upload failed:', error);
        return;
      }

      const result = await response.json();
      console.log('✅ Batch sent successfully:', result);

      // Clear buffer after successful send
      this.locationBuffer = [];
    } catch (error) {
      console.error('❌ Error sending batch:', error);
      // Keep locations in buffer for retry
    }
  }

  /**
   * Generate unique nonce for replay attack prevention
   */
  private generateNonce(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

export const trackingService = new TrackingService(
  process.env.REACT_APP_API_URL || 'http://192.168.1.6:3000'
);
```

---

## 2. Location Permission & Geolocation Hook (React Native)

### For React Native - `useLocationTracking.ts`

```typescript
// hooks/useLocationTracking.ts

import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { trackingService } from '../services/trackingService';

interface UseLocationTrackingProps {
  enabled: boolean;
  tripId?: string;
  driverId?: string;
  busId?: string;
  updateInterval?: number; // milliseconds (default: 5000)
}

export const useLocationTracking = ({
  enabled,
  tripId,
  driverId,
  busId,
  updateInterval = 5000,
}: UseLocationTrackingProps) => {
  const [location, setLocation] = useState(null);
  const [error, setError] = useState<string | null>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    if (!enabled || !tripId || !driverId || !busId) {
      return;
    }

    const startTracking = async () => {
      try {
        // Request foreground permission
        const { status: foregroundStatus } =
          await Location.requestForegroundPermissionsAsync();
        
        if (foregroundStatus !== 'granted') {
          setError('Location permission denied');
          return;
        }

        // Request background permission (for continuous tracking)
        await Location.requestBackgroundPermissionsAsync();

        // Subscribe to location updates
        locationSubscription.current =
          await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.High,
              timeInterval: updateInterval,
              distanceInterval: 5, // Update every 5 meters
            },
            (location) => {
              setLocation(location);

              // Add to batch
              trackingService.addLocation({
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
                speed: location.coords.speed || undefined,
                heading: location.coords.heading || undefined,
                accuracy: location.coords.accuracy || undefined,
                batteryLevel: undefined, // Get from device battery API
                timestamp: new Date().toISOString(),
              });
            }
          );

        // Start batching
        trackingService.startBatching(tripId, driverId, busId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    };

    startTracking();

    return () => {
      if (locationSubscription.current) {
        locationSubscription.current.remove();
      }
      trackingService.stopBatching();
    };
  }, [enabled, tripId, driverId, busId, updateInterval]);

  return { location, error };
};
```

---

## 3. Usage in Trip Component (React Native)

### React Native Example - `DriverTripScreen.tsx`

```typescript
// screens/DriverTripScreen.tsx

import React, { useEffect, useState } from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { useLocationTracking } from '../hooks/useLocationTracking';
import { trackingService } from '../services/trackingService';
import { useAuth } from '../context/AuthContext';

export const DriverTripScreen = ({ trip }: { trip: any }) => {
  const { user } = useAuth();
  const [tripActive, setTripActive] = useState(false);

  const { location, error } = useLocationTracking({
    enabled: tripActive,
    tripId: trip._id,
    driverId: user?.id,
    busId: trip.busId,
    updateInterval: 5000,
  });

  useEffect(() => {
    // Set auth token when component mounts
    const authToken = localStorage.getItem('authToken');
    if (authToken) {
      trackingService.setAuthToken(authToken);
    }
  }, []);

  const handleStartTrip = () => {
    setTripActive(true);
    console.log('📍 Location tracking started');
  };

  const handleEndTrip = () => {
    setTripActive(false);
    console.log('📍 Location tracking stopped');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        Trip: {trip.busId}
      </Text>

      {location && (
        <Text style={styles.location}>
          📍 Lat: {location.coords.latitude.toFixed(6)}, Lng:{' '}
          {location.coords.longitude.toFixed(6)}
        </Text>
      )}

      {error && <Text style={styles.error}>❌ {error}</Text>}

      <Button
        title={tripActive ? '⏹️ Stop Tracking' : '▶️ Start Tracking'}
        onPress={tripActive ? handleEndTrip : handleStartTrip}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  location: {
    marginBottom: 10,
  },
  error: {
    color: 'red',
    marginBottom: 10,
  },
});
```

---

## 4. Web App Integration (React)

### For Web - `useLocationTracking.ts`

```typescript
// hooks/useLocationTracking.ts (Web)

import { useEffect, useRef } from 'react';
import { trackingService } from '../services/trackingService';

interface UseLocationTrackingProps {
  enabled: boolean;
  tripId?: string;
  driverId?: string;
  busId?: string;
}

export const useLocationTracking = ({
  enabled,
  tripId,
  driverId,
  busId,
}: UseLocationTrackingProps) => {
  const watchId = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !tripId || !driverId || !busId) {
      return;
    }

    if (!navigator.geolocation) {
      console.error('Geolocation not supported');
      return;
    }

    // Start tracking
    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        trackingService.addLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          speed: position.coords.speed || undefined,
          heading: position.coords.heading || undefined,
          accuracy: position.coords.accuracy || undefined,
          timestamp: new Date().toISOString(),
        });
      },
      (error) => {
        console.error('Geolocation error:', error);
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0,
      }
    );

    // Start batching
    trackingService.startBatching(tripId, driverId, busId);

    return () => {
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
      }
      trackingService.stopBatching();
    };
  }, [enabled, tripId, driverId, busId]);
};
```

---

## 5. Integration Checklist

- [ ] Copy `trackingService.ts` to your mobile app `services/` folder
- [ ] Create geolocation hook for your platform (React Native or Web)
- [ ] Request location permissions in your app
- [ ] Set auth token from login: `trackingService.setAuthToken(token)`
- [ ] Start tracking when trip starts: `startBatching(tripId, driverId, busId)`
- [ ] Stop tracking when trip ends: `stopBatching()`
- [ ] Verify data in Redis via RedisInsight
- [ ] Check backend logs for "✅ Batch sent successfully"

---

## 6. Testing Batch Upload

### Test in Postman/VS Code REST Client

```http
POST http://192.168.1.6:3000/api/tracking/batch
Authorization: Bearer YOUR_AUTH_TOKEN
Content-Type: application/json

{
  "tripId": "6a141ae8edd5337f4564c0be",
  "driverId": "69bcf19e7d6fe4ee68d09477",
  "busId": "69bcf16f7d6fe4ee68d09471",
  "batchTimestamp": "2026-05-25T09:48:00Z",
  "nonce": "unique-nonce-123",
  "locations": [
    {
      "latitude": 17.385,
      "longitude": 78.486,
      "speed": 10,
      "heading": 90,
      "accuracy": 5,
      "batteryLevel": 85,
      "timestamp": "2026-05-25T09:48:00Z"
    },
    {
      "latitude": 17.386,
      "longitude": 78.487,
      "speed": 12,
      "heading": 90,
      "accuracy": 5,
      "batteryLevel": 84,
      "timestamp": "2026-05-25T09:48:05Z"
    }
  ]
}
```

### Expected Response

```json
{
  "success": true,
  "processedCount": 2,
  "validCount": 2,
  "invalidCount": 0,
  "duplicateCount": 0,
  "cacheUpdated": true,
  "rateLimit": {
    "remaining": 9,
    "resetIn": 45000
  },
  "nextExpectedBatch": "2026-05-25T09:48:15Z"
}
```

Then check **RedisInsight** for:
```
location:driver_69bcf19e7d6fe4ee68d09477 → {"latitude": 17.386, "longitude": 78.487, ...}
location:bus_69bcf16f7d6fe4ee68d09471 → {...}
location:trip_6a141ae8edd5337f4564c0be → {...}
```

---

## 7. Environment Variables (.env for mobile app)

```bash
REACT_APP_API_URL=http://192.168.1.6:3000
# or for production:
REACT_APP_API_URL=https://your-production-api.com
```

---

## 8. Package Dependencies

### For React Native:
```bash
npm install expo-location expo-task-manager
# or
yarn add expo-location expo-task-manager
```

### For Web (React):
No additional packages needed - uses native Geolocation API

---

## 9. Common Issues & Solutions

### Issue: Locations not appearing in Redis

**Solution:**
- Ensure you're calling `trackingService.setAuthToken(token)` after login
- Check network tab in browser/device to see POST requests going to `/api/tracking/batch`
- Verify auth token is valid in backend logs
- Check that `tripId`, `driverId`, and `busId` match your trip data

### Issue: "Rate limit exceeded" error

**Solution:**
- Backend allows max 10 batches per minute per driver
- Currently batching every 15 seconds = 4 batches/minute ✅
- Don't send empty batches

### Issue: Geolocation permission denied

**Solution (React Native):**
```bash
# In app.json
{
  "plugins": [
    [
      "expo-location",
      {
        "locationAlwaysAndWhenInUsePermissions": "allow"
      }
    ]
  ]
}
```

---

## 10. Redis Cache Keys

Once data flows through the batch endpoint, you'll see these keys in Redis:

```
location:driver_{driverId}      → Latest driver location (30s TTL)
location:trip_{tripId}           → Latest trip location (30s TTL)
location:bus_{busId}             → Latest bus location (30s TTL)
```

Example data stored:
```json
{
  "latitude": 17.386,
  "longitude": 78.487,
  "speed": 12,
  "heading": 90,
  "accuracy": 5,
  "batteryLevel": 84,
  "timestamp": "2026-05-25T09:48:05Z"
}
```

---

## 11. Next Steps

1. ✅ Implement `trackingService.ts` in your mobile app
2. ✅ Add location hook to your trip screen
3. ✅ Test batch upload with Postman
4. ✅ Verify data appears in RedisInsight
5. ✅ Deploy mobile app with tracking enabled
6. ✅ Monitor passenger realtime updates via Socket.IO

---

**Need help? Check backend logs:**
```bash
cd backend-ts
npm start
# Look for "✅ Batch sent successfully" messages
```
