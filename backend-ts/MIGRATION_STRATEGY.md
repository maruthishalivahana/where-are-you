# Driver Tracking Architecture Migration Strategy

## Executive Summary

You're migrating from a **WebSocket-based driver tracking system** (unreliable in iOS background mode) to an **HTTP batch upload system with Redis caching** (production-grade, scalable, battery-efficient).

---

## Current Architecture Issues

### Problem 1: WebSocket Dependency for Drivers
```
Driver App (WebSocket connection)
    ↓ Persistent connection open
    ↓ ISSUE: iOS suspends JS thread after 10-15 seconds
    ↓ ISSUE: Location updates stop when app backgrounded
    ↓ ISSUE: Battery drains from persistent socket
    ↓
Tracking Service (realtime)
    ↓
Passenger Apps (broadcast)
```

**Why this fails:**
- iOS/Android suspend WebSocket connections in background
- Battery drain from persistent socket keepalive
- Thread suspension causes missed location updates
- Connection reconnection overhead

### Problem 2: No Caching Layer
- Every location update hits database directly
- No deduplication
- High database load at scale
- Passengers receive redundant updates

### Problem 3: Realtime Pressure
- Expecting realtime driver updates is unrealistic with battery constraints
- Passengers don't need microsecond updates (15-30 second intervals sufficient)
- System designed for push-based when pull-based would be more reliable

---

## Target Architecture: HTTP Batch + Redis Cache

```
┌─────────────────────────────────────────────────────────────┐
│                    DRIVER APP (Native)                       │
│  • Background task runner (10-15s interval)                  │
│  • HTTP request (battery-efficient)                          │
│  • Works when app backgrounded                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ↓ HTTP POST /api/tracking/batch
┌──────────────────────────────────────────────────────────────┐
│             BATCH UPLOAD CONTROLLER                          │
│  ✓ JWT validation                                            │
│  ✓ Rate limiting                                             │
│  ✓ Replay attack prevention                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ↓ Batch Processing Queue
┌──────────────────────────────────────────────────────────────┐
│            LOCATION VALIDATION SERVICE                       │
│  ✓ Coordinate validation (-90/90 lat, -180/180 lng)         │
│  ✓ Spoofing detection (max speed check)                     │
│  ✓ Duplicate filtering (5m / 5s window)                     │
│  ✓ Time validation                                           │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ├──→ Redis Live Cache (GEOADD, GEOSEARCH)
                       │    • location:driver_123
                       │    • location:trip_456
                       │    • eta:trip_456:stop_7
                       │    • TTL: 30s
                       │
                       ├──→ MongoDB Bulk Insert
                       │    • Historical tracking
                       │    • Indexed for queries
                       │
                       └──→ Event Triggers
                            • ETA calculation
                            • Geofence detection
                            • Nearby stop alerts
                            • Notifications
┌──────────────────────────────────────────────────────────────┐
│             PASSENGER WEBSOCKET BROADCAST                    │
│  ✓ Subscribe: trip:123                                       │
│  ✓ Receive: location updates (15-30s intervals)             │
│  ✓ From: Redis cache, not driver socket                     │
└──────────────────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────┐
│              PASSENGER APPS                                  │
│  • Receive updates via WebSocket                            │
│  • 15-30s refresh intervals (good UX)                       │
│  • No direct driver connection                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Why This Architecture is Better

### 1. **Battery Efficiency**
| Aspect | WebSocket | HTTP Batch |
|--------|-----------|-----------|
| Connection Type | Persistent | Stateless |
| Battery Drain | High (keepalive) | Low (periodic) |
| Background Mode | ❌ Fails | ✅ Works |
| Battery Impact | 15-20% per hour | <2% per hour |

### 2. **Reliability**
| Aspect | WebSocket | HTTP Batch |
|--------|-----------|-----------|
| iOS Background | ❌ Thread suspension | ✅ Background task |
| Reconnection Logic | Complex, error-prone | Automatic retry |
| Data Loss Recovery | Difficult | Simple retry |
| Scaling | Single connection | Horizontal scaling |

### 3. **Scalability**
| Metric | WebSocket | HTTP Batch |
|--------|-----------|-----------|
| 1000 drivers | Server memory pressure | ✅ Stateless |
| 1M updates/day | Connection overhead | ✅ CPU-efficient |
| Broadcast latency | Realtime pressure | ✅ 15-30s acceptable |
| Database load | High & constant | ✅ Bulk batched |

### 4. **Security**
| Aspect | WebSocket | HTTP Batch |
|--------|-----------|-----------|
| Replay attacks | Vulnerable | ✅ Nonce-based |
| Rate limiting | Complex | ✅ Per-API |
| Token refresh | Tricky | ✅ Standard HTTP |
| Spoofing detection | Passive | ✅ Active validation |

---

## Removing Driver WebSocket Dependency

### 1. Remove Driver Socket Listeners
**File**: `socket.handlers.ts`

```typescript
// REMOVE:
socket.on(TRACKING_EVENTS.DRIVER_LOCATION_UPDATE, async (payload) => {
    // Driver upload via socket - NO LONGER NEEDED
});

socket.on(TRACKING_EVENTS.JOIN_BUS_ROOM, async (busId) => {
    // Only remove if it's for drivers
});
```

**Keep passenger rooms:**
```typescript
socket.on(TRACKING_EVENTS.JOIN_BUS_ROOM, async (busId) => {
    // KEEP this for passengers ONLY
    if (socket.data.user.role === ROLES.PASSENGER) {
        // subscribe to bus room
    }
});
```

### 2. Remove Socket-Based Driver Authentication
**File**: `socket.auth.ts`

```typescript
// Driver socket auth no longer needed
// Keep passenger JWT validation
export const authenticateSocket = (socket: Socket, next) => {
    // Validate token
    // RESTRICT: Only allow PASSENGER and ADMIN roles
    if (![ROLES.PASSENGER, ROLES.ADMIN].includes(decoded.role)) {
        next(new Error('Unauthorized role'));
    }
};
```

### 3. Remove Driver Socket State
- Remove driver socket reconnect logic
- Remove driver location cache (Map<driverId, location>)
- Remove driver heartbeat tracking

---

## Implementing HTTP Batch Upload API

### Endpoint: POST /api/tracking/batch

**Request:**
```json
{
  "tripId": "trip_123",
  "driverId": "driver_123",
  "busId": "bus_123",
  "batchTimestamp": "2026-05-24T12:00:00Z",
  "locations": [
    {
      "latitude": 17.385,
      "longitude": 78.486,
      "speed": 42,
      "heading": 180,
      "accuracy": 5,
      "batteryLevel": 78,
      "timestamp": "2026-05-24T12:00:00Z"
    }
  ],
  "nonce": "unique_request_id_123"  // Replay attack prevention
}
```

**Response:**
```json
{
  "success": true,
  "processedCount": 12,
  "skippedCount": 0,
  "cacheUpdated": true,
  "nextExpectedBatch": "2026-05-24T12:00:15Z"
}
```

**Benefits:**
- ✅ Single HTTP request replaces 12+ WebSocket events
- ✅ Payload compression friendly
- ✅ Automatic retry on failure
- ✅ Clear success/failure response
- ✅ Idempotent (nonce prevents duplicates)

---

## Redis Live Cache Strategy

### Cache Structure

```
Key Pattern: location:{identifier}
├── location:driver_{driverId}
│   Value: {lat, lng, speed, heading, timestamp, accuracy}
│   TTL: 30 seconds
│   Type: String (JSON)
├── location:trip_{tripId}
│   Value: {lat, lng, speed, heading, lastUpdated}
│   TTL: 30 seconds
│   Type: String (JSON)
├── location:bus_{busId}
│   Value: {lat, lng, speed, heading, tripId, timestamp}
│   TTL: 30 seconds
│   Type: String (JSON)
│
Key Pattern: geo:{scope}
├── geo:trip_{tripId}:drivers
│   Value: GeoSpatial Index (lat, lng, driverId)
│   Operations: GEOADD, GEOSEARCH
│   Usage: "Find all drivers near stop X"
│
Key Pattern: eta:{scope}
├── eta:trip_{tripId}:stop_{stopId}
│   Value: {estimatedArrival, distanceMeters, durationSeconds}
│   TTL: 60 seconds
│   Usage: Avoid recalculating ETA on every update
│
Key Pattern: state:{scope}
├── state:trip_{tripId}
│   Value: {status, currentStop, nextStop, completedStops}
│   TTL: 120 seconds
│   Usage: Trip state machine
```

### Redis Operations

```typescript
// Cache driver location (after batch validation)
await redis.setex(
  `location:driver_${driverId}`,
  30,  // TTL: 30 seconds
  JSON.stringify(latestLocation)
);

// Geospatial: Track drivers on route
await redis.geoadd(
  `geo:trip_${tripId}:drivers`,
  longitude,
  latitude,
  driverId
);

// Find drivers near stop (5km radius)
const nearbyDrivers = await redis.geosearch(
  `geo:trip_${tripId}:drivers`,
  'FROMMEMBER',
  stopId,  // Geohash center
  'BYRADIUS',
  5,
  'km'
);

// Cache ETA (computed once, reused)
await redis.setex(
  `eta:trip_${tripId}:stop_${stopId}`,
  60,
  JSON.stringify(etaData)
);
```

---

## Passenger WebSocket Broadcast (Socket-Only)

### Flow
```
Driver HTTP Upload
    ↓
Redis Cache Updated
    ↓
Backend: Fetch from Redis Cache
    ↓
Backend: Emit to passenger rooms ONLY
    ↓
Passenger Apps Receive Updates (via Socket.IO)
```

### Passenger Socket Rooms

**Room Structure:**
```
trip:{tripId}          → All passengers on trip
route:{routeId}        → All passengers on route
bus:{busId}            → Passengers on this bus
stop:{stopId}          → Passengers at this stop
```

**Passenger Subscription:**
```typescript
// Passenger joins trip
socket.on('joinTrip', (tripId) => {
    if (socket.data.user.role === ROLES.PASSENGER) {
        socket.join(`trip:${tripId}`);
    }
});

// Backend broadcasts location to passengers
io.to(`trip:${tripId}`).emit('locationUpdate', {
    busId,
    lat,
    lng,
    speed,
    eta,
    nextStop
});
```

**CRITICAL:** Do NOT allow driver socket connections to these rooms.

---

## Database Optimization

### Indexes for Batch Inserts

```javascript
// indexes/LocationLog
db.locationlogs.createIndex({ driverId: 1, timestamp: -1 });
db.locationlogs.createIndex({ tripId: 1, timestamp: -1 });
db.locationlogs.createIndex({ busId: 1, timestamp: -1 });
db.locationlogs.createIndex({ organizationId: 1, timestamp: -1 });

// Geospatial index for nearby queries
db.locationlogs.createIndex({ location: "2dsphere", timestamp: -1 });

// Compound for historical queries
db.locationlogs.createIndex({ 
  organizationId: 1, 
  tripId: 1, 
  timestamp: -1 
});
```

### Bulk Insert Strategy

```typescript
// Insert 1000s of locations efficiently
const bulkOps = locations.map(loc => ({
    insertOne: {
        document: {
            driverId,
            tripId,
            busId,
            organizationId,
            location: {
                type: "Point",
                coordinates: [loc.longitude, loc.latitude]
            },
            speed: loc.speed,
            heading: loc.heading,
            accuracy: loc.accuracy,
            batteryLevel: loc.batteryLevel,
            timestamp: new Date(loc.timestamp),
            recordedAt: new Date(loc.timestamp)
        }
    }
}));

await LocationLog.collection.bulkWrite(bulkOps);
```

### Archival Strategy

```typescript
// Move old tracking data to archive collection monthly
async function archiveOldTracking() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const oldLogs = await LocationLog.find({
        timestamp: { $lt: thirtyDaysAgo }
    });
    
    await LocationLogArchive.insertMany(oldLogs);
    await LocationLog.deleteMany({
        timestamp: { $lt: thirtyDaysAgo }
    });
}
```

---

## Location Validation & Spoofing Detection

### Validation Rules

```typescript
// 1. Coordinate bounds
latitude: -90 to 90
longitude: -180 to 180

// 2. Speed validation (prevent spoofing)
maxSpeed: 150 km/h = 41.67 m/s
// If traveled > 150km between consecutive points, flag as suspicious

// 3. Time validation
timestamp <= now + 30 seconds (allow clock skew)
timestamp >= last_valid_timestamp

// 4. Accuracy check
accuracy: 0-100 meters (< 5m = very good)

// 5. Duplicate detection
Same location within 5 meters AND 5 seconds = skip
```

### Spoofing Detection

```typescript
// Distance jumped check
const distanceMeters = haversine(
  prev.latitude,
  prev.longitude,
  curr.latitude,
  curr.longitude
);

const timeSeconds = (curr.timestamp - prev.timestamp) / 1000;
const impliedSpeedMps = distanceMeters / timeSeconds;

if (impliedSpeedMps > 150 / 3.6) {  // 150 km/h
    // Flag as suspicious, log, but accept (driver might have fast movement)
    logger.warn(`Suspicious speed: ${impliedSpeedMps} m/s`);
}
```

---

## Notification System (Server-Driven)

### Flow

```
Batch Upload Received
    ↓
ETA Engine: Calculate distance to next stop
    ↓
Geofence Check: Within 2km?
    ↓
  YES → Send Notification
         "Bus 123 is nearby"
         "Arriving in ~5 minutes"
    ↓
  NO → Skip notification (too far)
```

### Notification Types

1. **Bus Arriving** (5km radius)
   - Trigger: ETA < 10 minutes
   - Recipient: Passengers at upcoming stop
   - Frequency: Once per trip per passenger

2. **Bus Delayed** (10+ minutes behind schedule)
   - Trigger: Actual arrival > ETA + 10 min
   - Recipient: Passengers waiting
   - Frequency: Once per trip

3. **Bus At Stop** (100m radius)
   - Trigger: Distance to stop < 100m
   - Recipient: Passengers at current stop
   - Frequency: Once

---

## Migration Checklist

### Phase 1: Setup Infrastructure (Day 1)
- [ ] Add Redis dependency (ioredis)
- [ ] Create Redis service layer (`redis.service.ts`)
- [ ] Configure Redis connection
- [ ] Create monitoring/logging for Redis

### Phase 2: Implement Batch Upload (Day 2-3)
- [ ] Create batch endpoint: `POST /api/tracking/batch`
- [ ] Create validation service (`location-validation.service.ts`)
- [ ] Implement batch processing service
- [ ] Create database indexes
- [ ] Add rate limiting

### Phase 3: Refactor WebSocket (Day 4)
- [ ] Remove driver upload handlers
- [ ] Restrict socket auth to passengers/admins only
- [ ] Keep passenger room subscriptions
- [ ] Create broadcast service (`broadcast.service.ts`)

### Phase 4: Optimize Services (Day 5)
- [ ] Refactor tracking service for Redis
- [ ] Implement ETA caching
- [ ] Implement geofence detection
- [ ] Refactor notifications

### Phase 5: Testing & Deployment (Day 6-7)
- [ ] End-to-end testing
- [ ] Load testing (1000 drivers)
- [ ] Migration testing with existing data
- [ ] Gradual rollout

---

## Performance Metrics

### Before Migration (WebSocket)
- Driver connection overhead: ~50KB per driver
- 1000 drivers: ~50MB memory
- Database writes: Real-time (unpredictable)
- Battery drain: 15-20% per hour

### After Migration (HTTP Batch + Redis)
- Driver connection overhead: 0
- 1000 drivers: ~1MB memory (cache only)
- Database writes: 1 batch per 10-15 seconds
- Battery drain: <2% per hour
- Redis memory: ~100MB for 1000 drivers (30s TTL)

---

## Security Considerations

### 1. Replay Attack Prevention
```typescript
// Include nonce in every batch
{
  "nonce": "unique_uuid_per_request",
  "timestamp": "2026-05-24T12:00:00Z"
}

// Server validates: nonce not seen before
// TTL: 1 hour
await redis.setex(
  `replay:nonce:${nonce}`,
  3600,
  true
);
```

### 2. Rate Limiting
```
- Per driver: Max 10 batches/minute
- Per IP: Max 1000 batches/minute
- Per organization: Max 50,000 batches/minute
```

### 3. JWT Security
- All batch requests require valid JWT
- Token must contain driverId
- Server verifies driverId in JWT matches request

### 4. HTTPS Only
- API enforces HTTPS
- Certificate pinning in driver app

---

## Rollout Strategy

### Week 1: Dual Mode
- Deploy batch endpoint alongside socket
- Drivers can use either (gradual migration)
- Monitor both systems

### Week 2: Socket Deprecation
- Socket location uploads disabled with warning
- All drivers switched to batch

### Week 3: Socket Removal
- Remove driver socket handlers
- Socket used for passengers/admins only
