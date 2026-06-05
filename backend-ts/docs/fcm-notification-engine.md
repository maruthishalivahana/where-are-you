# FCM Notification Engine Implementation Guide

## Overview
Complete Firebase Cloud Messaging (FCM) notification system for NavixGo bus tracking platform with voice notifications, deduplication, and distance-based triggers.

## Architecture

### Key Components

1. **FCM Configuration** (`src/config/fcm.config.ts`)
   - Initializes Firebase Admin SDK with credentials from environment
   - Exports messaging service for sending notifications

2. **Device Token Management** (`src/modules/notification/deviceToken.model.ts`)
   - Stores user device tokens (iOS, Android, Web)
   - Tracks active devices and last usage
   - Supports multiple devices per user

3. **Notification Model** (`src/modules/notification/notification.model.ts`)
   - Stores notification history with delivery status
   - Includes voice message for TTS playback
   - Tracks retries and failure reasons

4. **Notification Service** (`src/modules/notification/notification.service.ts`)
   - FCM integration for sending messages
   - Device token registration and validation
   - User preference retrieval
   - Deduplication logic

5. **Event Listeners** (`src/modules/notification/notification.events.ts`)
   - `TRIP_STARTED` → Send "Your bus has started"
   - `BUS_LOCATION_UPDATE` → Calculate distance and send near/arrived alerts
   - `DELAY_ALERT` → Send delay notifications
   - Built-in deduplication per trip/bus/user/type

6. **Routes** (`src/modules/notification/deviceToken.routes.ts`)
   - `POST /api/notifications/register-device` - Register FCM token
   - `GET /api/notifications/preferences` - Get user notification settings

## Notification Types & Triggers

### 1. TRIP_STARTED
**When:** Trip status changes `Pending → Active`
```
Title: "Trip Started"
Body: "Your bus has started and is on the way."
Voice: "Your bus has started and is on the way. Please be ready."
```
- Sent to all students assigned to that bus
- Respects `tripStartedEnabled` preference
- One-time per trip (deduped)

### 2. BUS_NEAR_STOP
**When:** Distance ≤ 500m (configurable)
```
Title: "Bus Near Your Stop"
Body: "Your bus is approaching [Stop Name]."
Voice: "Your bus is approaching [Stop Name]. Please be ready."
```
- Calculated from: Bus Location ↔ Student's Assigned Stop
- Uses student's `stopId` from User model (not current GPS)
- One-time per trip per stop (deduped)
- Respects `busNearStopEnabled` preference

### 3. BUS_ARRIVED
**When:** Distance ≤ 50m (configurable)
```
Title: "Bus Arrived"
Body: "Your bus has arrived at [Stop Name]."
Voice: "Your bus has arrived at [Stop Name]."
```
- Same distance calculation as BUS_NEAR_STOP
- One-time per trip per stop (deduped)
- Respects `busArrivedEnabled` preference

### 4. DELAY_ALERT
**When:** Bus deviates from schedule
```
Title: "Bus Delayed"
Body: "Your bus is delayed by X minutes. [Reason]"
Voice: "Your bus is delayed by X minutes."
```
- Sent to all students on route
- One-time per trip (configurable per org)
- Respects `delayAlertsEnabled` preference

## Distance Logic (Critical)

❌ **DO NOT USE:** Student's current GPS location  
✅ **USE:** Student's assigned stop location

```
Distance = calculateDistanceMeters(
  busLatitude, busLongitude,
  student.stopId.latitude, student.stopId.longitude
)
```

**Why?** Students may be at home, hostel, or elsewhere when notification is sent. Consistency requires using assigned stops.

## Deduplication Strategy

Notifications are tracked per trip/bus/user/type:

```
Key = "${type}_${tripId}_${busId}_${userId}"
```

Each type is sent once per trip:
- `TRIP_STARTED` → once
- `BUS_NEAR_STOP` → once per stop (key includes tripId/busId/userId/type)
- `BUS_ARRIVED` → once per stop (separate from NEAR_STOP)
- `DELAY_ALERT` → once per trip (configurable)

Memory cache cleared on server restart (OK for now; can use Redis later).

## User Preferences

Stored in `User.notificationPreferences`:
```typescript
{
  tripStartedEnabled: boolean,      // default: true
  busNearStopEnabled: boolean,      // default: true
  busArrivedEnabled: boolean,       // default: true
  delayAlertsEnabled: boolean       // default: true
}
```

All default to `true`. Checked before sending.

## Implementation Flow

### 1. Register Device Token (Mobile/Web)
```bash
POST /api/notifications/register-device
{
  "deviceToken": "token_from_fcm",
  "deviceType": "android" | "ios" | "web"
}
```

Response:
```json
{
  "success": true,
  "message": "Device token registered successfully"
}
```

### 2. Trip Status Changes to Active
Backend triggers: `eventBus.emit('TRIP_STARTED', { tripId, busId, organizationId })`

Event listener:
- Queries all users with `stopId` on this route
- Checks `tripStartedEnabled` preference
- Sends FCM notification to all device tokens
- Saves to notification history
- Marks as deduped

### 3. Bus Location Update
Backend triggers: `eventBus.emit('BUS_LOCATION_UPDATE', { busId, tripId, organizationId, latitude, longitude })`

Event listener:
- Calculates distance from bus to each student's assigned stop
- If distance ≤ 500m: sends BUS_NEAR_STOP notification (one-time)
- If distance ≤ 50m: sends BUS_ARRIVED notification (one-time)
- Respects preferences and deduplication

### 4. Delay Detected
Backend triggers: `eventBus.emit('DELAY_ALERT', { tripId, busId, organizationId, delayMinutes, reason })`

Event listener:
- Sends to all students on route
- Respects `delayAlertsEnabled` preference
- One-time per trip (deduped)

## FCM Payload Structure

Every notification includes:
```json
{
  "notification": {
    "title": "...",
    "body": "..."
  },
  "data": {
    "notificationType": "TRIP_STARTED|BUS_NEAR_STOP|BUS_ARRIVED|DELAY_ALERT",
    "tripId": "...",
    "busId": "...",
    "voiceMessage": "..."
  }
}
```

Frontend receives and can:
- Display notification via OS/browser
- Play `data.voiceMessage` via TTS library
- Link to trip/bus details via tripId/busId

## Voice Notifications (Frontend)

Frontend should:
1. Receive FCM message with `voiceMessage` in data
2. Use Web Speech API or native TTS:
   ```js
   const utterance = new SpeechSynthesisUtterance(data.voiceMessage);
   speechSynthesis.speak(utterance);
   ```
3. Handle per-trip deduplication (don't replay same message)

## Event Triggers (Where to emit)

### TRIP_STARTED
In Trip or Tracking controller when status changes to ACTIVE:
```ts
eventBus.emit('TRIP_STARTED', {
  tripId: trip._id.toString(),
  busId: trip.busId.toString(),
  organizationId: trip.organizationId.toString(),
});
```

### BUS_LOCATION_UPDATE
In Tracking controller when driver sends location:
```ts
eventBus.emit('BUS_LOCATION_UPDATE', {
  busId: busId,
  tripId: tripId,
  organizationId: organizationId,
  latitude: location.latitude,
  longitude: location.longitude,
});
```

### DELAY_ALERT
In Trip/Tracking service when delay detected:
```ts
eventBus.emit('DELAY_ALERT', {
  tripId: trip._id.toString(),
  busId: trip.busId.toString(),
  organizationId: trip.organizationId.toString(),
  delayMinutes: 15,
  reason: "Traffic congestion",
});
```

## Database Models Extended

### User
Added fields:
- `stopId: ObjectId` — Student's assigned stop
- `notificationPreferences: { tripStartedEnabled, busNearStopEnabled, busArrivedEnabled, delayAlertsEnabled }`

### Notification
Extended with:
- `tripId: ObjectId` — Link to trip
- `voiceMessage: string` — TTS message
- `deliveredAt: Date` — Delivery timestamp
- `failureReason: string` — If FCM send failed
- `retryCount: number` — Retry attempts

### DeviceToken (New)
```typescript
{
  userId: ObjectId,
  deviceToken: string (unique),
  deviceType: 'ios' | 'android' | 'web',
  isActive: boolean,
  lastUsedAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

## Configuration (Environment Variables)

Already present in `.env`:
```
FIREBASE_PROJECT_ID=cryptohub-9f044
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@cryptohub-9f044.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

These are used by `src/config/fcm.config.ts` to initialize Firebase Admin SDK.

## Testing

### Register a Test Device
```bash
curl -X POST http://localhost:3000/api/notifications/register-device \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceToken": "test_token_from_fcm",
    "deviceType": "android"
  }'
```

### Emit Test Event
```ts
import { eventBus } from './events/eventBus';

// Simulate trip start
eventBus.emit('TRIP_STARTED', {
  tripId: '507f1f77bcf86cd799439011',
  busId: '507f1f77bcf86cd799439012',
  organizationId: '507f1f77bcf86cd799439010',
});

// Simulate location update
eventBus.emit('BUS_LOCATION_UPDATE', {
  busId: '507f1f77bcf86cd799439012',
  tripId: '507f1f77bcf86cd799439011',
  organizationId: '507f1f77bcf86cd799439010',
  latitude: 28.7041,
  longitude: 77.1025,
});

// Simulate delay
eventBus.emit('DELAY_ALERT', {
  tripId: '507f1f77bcf86cd799439011',
  busId: '507f1f77bcf86cd799439012',
  organizationId: '507f1f77bcf86cd799439010',
  delayMinutes: 10,
  reason: "Traffic",
});
```

### Check Notifications in DB
```bash
db.notifications.find({ type: 'trip_started' }).pretty()
```

## Scalability Notes

- **Deduplication:** In-memory map (fine for single server; use Redis for multi-server)
- **Device Token Validation:** Bad tokens auto-deactivated
- **Batch Sending:** Currently sequential; can parallelize with `Promise.all`
- **Retry:** Currently not retrying failed sends; can implement with queue (Bull/BullMQ)
- **History:** All sends logged to database for audit

## Known Limitations

1. Dedup cache clears on server restart (OK for dev; use Redis for prod)
2. No exponential backoff on FCM retries
3. No topic subscriptions (could optimize for routes with many students)
4. No analytics/delivery tracking (can add to Notification model)

## Security

- Device tokens unique per device
- Tokens deactivated if invalid (prevents spam to dead devices)
- User preferences respected (opt-out support)
- Notifications only sent to assigned students (no cross-organization leaks)

## Logs

Check server logs for notification activity:
```
Device token registered: userId
FCM sent to device: messageId
BUS_NEAR_STOP sent to userId: success/failure
TRIP_STARTED already notified: key
Duplicate notification prevented: key
```

## Files Created/Modified

**Created:**
- `src/config/fcm.config.ts` — Firebase initialization
- `src/modules/notification/deviceToken.model.ts` — Device token storage
- `src/modules/notification/deviceToken.routes.ts` — Token registration endpoints
- `src/modules/notification/notification.events.ts` — Event listeners & dedup logic

**Modified:**
- `src/modules/notification/notification.model.ts` — Added tripId, voiceMessage, deliveredAt, retryCount
- `src/modules/notification/notification.service.ts` — Added FCM sending, token management, preferences
- `src/modules/user/user.model.ts` — Added stopId, notificationPreferences
- `src/constants/notificationTypes.ts` — Added BUS_ARRIVED, TRIP_STARTED, DELAY_ALERT
- `src/server.ts` — Registered routes and initialized notification listeners

## Next Steps (Optional)

1. **Add Redis dedup cache** for multi-server deployments
2. **Implement retry queue** with Bull/BullMQ
3. **Add topic subscriptions** for efficient bulk sends
4. **Integrate with analytics** (track delivery rates, user engagement)
5. **Add admin API** to send test/manual notifications
6. **Create mobile SDK** to handle voice notifications
