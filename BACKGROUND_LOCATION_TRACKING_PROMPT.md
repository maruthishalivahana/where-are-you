# Background Location Tracking Fix - VS Code Prompt

## Problem Statement
The HTTP Sync Manager stops syncing location data when the mobile app is minimized or the device screen is turned off. Location collection must continue in the background to maintain real-time tracking for drivers.

## Context

### Backend Architecture
- **Endpoint**: `POST /api/tracking/batch`
- **Payload**: Batched locations (tripId, driverId, busId, locations array)
- **Batch Interval**: 15 seconds
- **Location Collection**: Every 2-5 seconds via GPS
- **Redis Integration**: Backend automatically caches latest location in Redis
- **Real-time**: Socket.IO broadcasts busLocationUpdate to passengers

### Current Issues
1. JavaScript timers (`setInterval`) stop when app goes to background
2. GPS watch callbacks are suspended during minimization
3. No foreground service or background task configured
4. Location queue is lost on app termination

## Requirements

### For React Native (Expo or Bare)
- Use `react-native-background-actions` for foreground service (Android)
- Use `expo-task-manager` + `expo-location` for background location updates
- Implement battery-aware batching (adjust interval based on battery level)
- Ensure service continues even when app is closed

### For Flutter
- Use `background_locator` package for background tracking
- Use `workmanager` for periodic location sync
- Implement proper Android Manifest permissions
- Use iOS Background Modes (Location, Background Fetch)

### For Native (iOS/Android)
- **Android**: ForegroundService + WorkManager API
- **iOS**: CLLocationManager with `UIApplicationDidEnterBackground` lifecycle
- Both: Request appropriate permissions (BACKGROUND_LOCATION)

## Implementation Requirements

1. **Persistent Location Collection**
   - Continue GPS tracking when app is backgrounded
   - Keep local queue in persistent storage (localStorage, AsyncStorage, SQLite)
   - Resume from queue on app restart

2. **Background Sync Task**
   - Send batched locations every 15 seconds (even when backgrounded)
   - Exponential backoff on network failure
   - Queue failed batches for retry

3. **Battery Optimization**
   - Reduce location accuracy when on low battery (< 20%)
   - Increase batch interval to 30 seconds if low battery detected
   - Resume normal 15s interval when battery recovers

4. **Lifecycle Management**
   - Start background tracking when trip starts
   - Stop background service when trip ends
   - Handle app termination gracefully (cleanup)
   - Reconnect on app resume

## Expected Behavior

✅ **When app is minimized:**
- GPS continues collecting locations
- Sync interval continues firing every 15 seconds
- Batches are sent to `/api/tracking/batch`
- Backend receives and broadcasts to passengers in real-time

✅ **When screen is off:**
- Same as minimized behavior
- Battery is optimized by reducing location frequency

✅ **When app is completely closed:**
- Foreground service continues running (notification visible)
- Local queue persists to disk
- Next sync attempt happens after service restarts

✅ **On app resume:**
- Reconnect to fresh GPS stream
- Flush any pending queued batches
- Resume normal 15-second sync interval

## API Contract
```typescript
// Batch sync endpoint (backend)
POST /api/tracking/batch
Headers:
  Authorization: Bearer <jwt-token>
  Content-Type: application/json

Body:
{
  "tripId": "string",
  "driverId": "string",
  "busId": "string",
  "batchTimestamp": "ISO-8601 timestamp",
  "nonce": "unique string",
  "locations": [
    {
      "latitude": number,
      "longitude": number,
      "accuracy": number,
      "speed": number,
      "heading": number,
      "timestamp": "ISO-8601 timestamp",
      "batteryLevel": number
    }
  ]
}

Response (200 OK):
{
  "success": true,
  "message": "Batch synced",
  "syncedCount": number,
  "timestamp": "ISO-8601 timestamp"
}
```

## Code Structure Pattern

```
services/
  ├── backgroundLocationService.ts      # Foreground service setup
  ├── locationQueueService.ts           # Persistent queue management
  ├── httpSyncManager.ts                # HTTP batch sync (background-aware)
  └── batteryOptimizationService.ts     # Battery-aware adjustments

hooks/
  └── useBackgroundTracking.ts          # React hook wrapper

utils/
  └── backgroundTaskPermissions.ts      # Permission helpers
```

## Testing Checklist

- [ ] Open app, start trip, minimize → locations sync
- [ ] Turn off screen → locations sync continues
- [ ] Close app completely → foreground service stays alive
- [ ] App crashes → recovery mechanism restarts sync
- [ ] Low battery (< 20%) → interval increases to 30s
- [ ] Battery recovers → interval returns to 15s
- [ ] Poor connectivity → backoff and retry mechanism works
- [ ] Receive `/api/tracking/batch` success in network tab
- [ ] Backend broadcasts busLocationUpdate via Socket.IO
- [ ] Passengers see live bus updates in real-time

## Performance Targets

| Metric | Target |
|--------|--------|
| Location collection interval | 2-5 seconds |
| Batch sync interval | 15 seconds |
| Battery drain (backgrounded) | < 5% per hour |
| Network retry delay | 5s, 10s, 30s exponential backoff |
| Memory usage | < 50MB for queue + service |

## Success Criteria

✅ Locations are collected and synced **even when app is minimized**
✅ Locations are collected and synced **even when screen is off**
✅ Service continues running **even after app is closed** (until trip ends)
✅ No data loss on app restart
✅ Passengers receive real-time updates without interruption
