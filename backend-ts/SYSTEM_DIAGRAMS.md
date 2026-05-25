# System Architecture Diagrams

## Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          DRIVER APP (Native)                             │
│                                                                         │
│  • Background task runner (10-15s interval)                            │
│  • Collects GPS: lat, lng, speed, heading, accuracy, battery          │
│  • Uses native iOS/Android background APIs                            │
│  • HTTP-only (no WebSocket)                                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ HTTP POST (stateless, battery-friendly)
                             │ Content: up to 100 GPS locations
                             ↓
┌─────────────────────────────────────────────────────────────────────────┐
│                    BACKEND BATCH CONTROLLER                              │
│                                                                         │
│  1. JWT Validation (verify driver identity)                           │
│  2. Request Validation (structure, required fields)                   │
│  3. Replay Check (nonce must be unique)                               │
│  4. Rate Limiting (10 batches/min per driver)                         │
│                                                                         │
│  If invalid → 400 Bad Request                                        │
│  If rate limited → 429 Too Many Requests                            │
│  If valid → Continue                                                  │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ↓
┌─────────────────────────────────────────────────────────────────────────┐
│              LOCATION VALIDATION SERVICE                                 │
│                                                                         │
│  For each location in batch:                                          │
│  ✓ Coordinate bounds (-90/90 lat, -180/180 lng)                     │
│  ✓ Speed validation (detect unrealistic jumps)                       │
│  ✓ Time validation (not in future, not > 24h old)                   │
│  ✓ Accuracy validation (log if low confidence)                       │
│  ✓ Duplicate filtering (same location within 5m/5s)                 │
│  ✓ Sort by timestamp (ensure chronological order)                    │
│                                                                         │
│  Output:                                                              │
│  • Valid locations (ready for database)                              │
│  • Invalid locations (logged, rejected)                              │
│  • Duplicate count (deduped)                                         │
│  • Suspicious count (logged but accepted)                            │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ↓                   ↓                   ↓
    ┌─────────┐         ┌──────────┐      ┌────────────┐
    │ MongoDB │         │  Redis   │      │  Broadcast │
    │ Bulk    │         │  Cache   │      │  Service   │
    │ Insert  │         │  Update  │      │(Sockets)   │
    └────┬────┘         └────┬─────┘      └─────┬──────┘
         │                   │                   │
         ↓                   ↓                   ↓
    ┌─────────────────────────────────────────────────┐
    │  Historical Database (Queryable)                │
    │  - Indexed by trip, driver, bus, timestamp      │
    │  - Geospatial (2dsphere) for location queries  │
    │  - Partitioned by organization                  │
    │  - Used for analytics, history, recovery        │
    └─────────────────────────────────────────────────┘
    
    ┌──────────────────────────────────────────────────┐
    │  Redis Live Cache (30s TTL)                      │
    │  - location:driver_123 → Latest driver location │
    │  - location:trip_456 → Latest trip location    │
    │  - location:bus_789 → Latest bus location      │
    │  - geo:trip_456:drivers → Geospatial index    │
    │  - eta:trip_456:stop_7 → Cached ETA           │
    │  - Used for fast broadcast to passengers       │
    └──────────────────────────────────────────────────┘
    
    ┌──────────────────────────────────────────────────┐
    │  WebSocket Broadcast (Passengers Only)           │
    │  - Backend emits to room: trip:456              │
    │  - Event: busLocationUpdate                     │
    │  - Data: {lat, lng, speed, eta, ...}            │
    │  - Frequency: ~15-30s (from cache updates)      │
    └──────────────────────────────────────────────────┘
```

---

## Real-Time Data Pipeline

```
TIME    DRIVER APP              BACKEND              REDIS CACHE          PASSENGER APP
────    ──────────              ───────              ───────────          ─────────────
T+0s    [Collecting GPS]        
        
T+5s    [GPS point 1]          
        [GPS point 2]
        [GPS point 3]
        
T+10s   [GPS point 4]
        [GPS point 5]
        
T+15s   [Ready to upload]       
        ↓
T+15.1s [HTTP POST batch]  →    [Validation]
                           →    [Duplicate check]
                           →    [Rate limit OK]
                           →    [Spoofing check]
                           →    [DB bulk insert] ✓
                                                 ↓
                                            [SETEX cache] ✓
                                            [GEOADD index] ✓
                                            [Send event]
                                                         ↓
                                                    [Receive update] ✓
T+15.2s [Response 200 OK]  ←    [200 OK]    ←     
        [Clear queue]

T+15.3s Start new batch
        [Collecting GPS]

T+30s   [5 more GPS points]
        [Ready to upload]  →    [Process] →       [Cache update]      → [Update UI]
        
[Pattern repeats every 15 seconds]
```

---

## Request/Response Lifecycle

```
REQUEST: POST /api/tracking/batch
═════════════════════════════════════════════════════════════════

{
  "tripId": "507f1f77bcf86cd799439011",
  "driverId": "507f1f77bcf86cd799439012",
  "busId": "507f1f77bcf86cd799439013",
  "batchTimestamp": "2026-05-24T12:00:15Z",
  "nonce": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
  "locations": [
    { "latitude": 17.3850, "longitude": 78.4860, ... },
    { "latitude": 17.3851, "longitude": 78.4861, ... },
    { "latitude": 17.3852, "longitude": 78.4862, ... }
  ]
}

PROCESSING STEPS
════════════════════════════════════════════════════════════════

1. JWT Validation
   └─ Verify token signature ✓
   └─ Check expiration ✓
   └─ Extract driverId from JWT ✓

2. Request Validation
   └─ Check all required fields present ✓
   └─ Validate data types ✓
   └─ Max 100 locations ✓

3. Identity Verification
   └─ payload.driverId === JWT.sub ✓

4. Rate Limit Check
   └─ Increment counter for driver ✓
   └─ Check limit (10/minute) ✓
   └─ Return remaining quota ✓

5. Replay Attack Prevention
   └─ Check if nonce seen before ✓
   └─ Store nonce in Redis ✓
   └─ Set 1-hour TTL ✓

6. Batch Validation & Filtering
   └─ Validate coordinates (-90/90, -180/180) ✓
   └─ Validate timestamps (< 24h old) ✓
   └─ Check speed (flag if > 150 km/h) ✓
   └─ Filter duplicates (same location within 5m/5s) ✓
   └─ Sort by timestamp ✓

7. Database Insert
   └─ Build bulk insert operations ✓
   └─ Insert to LocationLog collection ✓
   └─ Return insert count ✓

8. Redis Cache Update
   └─ SETEX location:driver_ID (30s TTL) ✓
   └─ SETEX location:trip_ID (30s TTL) ✓
   └─ SETEX location:bus_ID (30s TTL) ✓
   └─ GEOADD geo:trip_ID:drivers ✓

9. WebSocket Broadcast
   └─ Emit to room trip:ID ✓
   └─ Event: busLocationUpdate ✓
   └─ Payload: latest location data ✓

RESPONSE: 200 OK
════════════════════════════════════════════════════════════════

{
  "success": true,
  "processedCount": 3,
  "validCount": 3,
  "invalidCount": 0,
  "duplicateCount": 0,
  "cacheUpdated": true,
  "rateLimit": {
    "remaining": 8,
    "resetIn": 60
  },
  "nextExpectedBatch": "2026-05-24T12:00:30Z"
}
```

---

## Database Schema (LocationLog)

```
db.locationlogs.schema:
{
  _id: ObjectId,
  
  // Identification
  organizationId: ObjectId,
  driverId: ObjectId,
  tripId: ObjectId,
  busId: ObjectId,
  
  // Location Data
  latitude: Number,          // -90 to 90
  longitude: Number,         // -180 to 180
  location: {
    type: "Point",           // GeoJSON format
    coordinates: [lng, lat]  // [longitude, latitude]
  },
  
  // Telemetry
  speed: Number,             // m/s
  heading: Number,           // degrees 0-360
  accuracy: Number,          // meters
  batteryLevel: Number,      // percent 0-100
  
  // Timestamps
  timestamp: Date,           // When GPS was collected
  recordedAt: Date,          // When received by backend
  createdAt: Date            // When inserted to DB
}

INDEXES:
{
  // Query by driver
  { driverId: 1, timestamp: -1 }
  
  // Query by trip
  { tripId: 1, timestamp: -1 }
  
  // Query by bus
  { busId: 1, timestamp: -1 }
  
  // Query by organization
  { organizationId: 1, timestamp: -1 }
  
  // Geospatial queries (nearby locations)
  { location: "2dsphere", timestamp: -1 }
  
  // Complex queries (org + trip + time)
  { organizationId: 1, tripId: 1, timestamp: -1 }
  
  // TTL Index (optional - auto-delete after 90 days)
  { createdAt: 1 } with { expireAfterSeconds: 7776000 }
}
```

---

## Redis Key Structure

```
LOCATION DATA (30s TTL)
├── location:driver_{driverId}
│   Value: { latitude, longitude, speed, heading, accuracy, batteryLevel, timestamp }
│   Updated: Every batch upload
│   Used by: Broadcast service to get latest location
│
├── location:trip_{tripId}
│   Value: { latitude, longitude, speed, heading, timestamp }
│   Updated: Every batch upload
│   Used by: Passenger app to see trip location
│
└── location:bus_{busId}
    Value: { latitude, longitude, speed, heading, timestamp, tripId }
    Updated: Every batch upload
    Used by: Bus tracking, fleet management

GEOSPATIAL INDEX (60s TTL)
└── geo:trip_{tripId}:drivers
    Type: Geospatial (ZSET)
    Members: driverId with coordinates [longitude, latitude]
    Operations: GEOADD, GEOSEARCH
    Used by: Nearby driver queries, geofencing

ETA CACHE (60s TTL)
└── eta:trip_{tripId}:stop_{stopId}
    Value: { estimatedArrival, distanceMeters, durationSeconds }
    Updated: After ETA calculation
    Used by: Passenger app ETA display, notifications

STATE MACHINE (120s TTL)
└── state:trip_{tripId}
    Value: { status, currentStop, nextStop, completedStops }
    Updated: When trip state changes
    Used by: Trip status tracking

RATE LIMITING (60s TTL)
└── ratelimit:driver:{driverId}
    Type: Counter (INCR)
    Value: Number of batches in current minute
    Updated: On each batch request
    Used by: Rate limit enforcement

REPLAY PREVENTION (3600s TTL)
└── replay:nonce:{nonce}
    Value: "true"
    Created: After successful batch processing
    Used by: Duplicate request detection

EXAMPLE KEYS IN REDIS:
  location:driver_123abc → { lat: 17.385, lng: 78.486, ... }
  location:trip_456def → { lat: 17.385, lng: 78.486, ... }
  location:bus_789ghi → { lat: 17.385, lng: 78.486, tripId: 456def }
  geo:trip_456def:drivers → ZSET { 123abc [78.486, 17.385], ... }
  eta:trip_456def:stop_1 → { arrival: "2026-05-24T12:15:00Z", distance: 5000 }
  state:trip_456def → { status: "active", currentStop: "1", nextStop: "2" }
  ratelimit:driver:123abc → 7
  replay:nonce:550e8400-e29b-41d4-a716-446655440000 → "true"
```

---

## WebSocket Room Architecture

```
io (Socket.IO server)
│
├── Room: trip:507f1f77bcf86cd799439011
│   │
│   ├── Passenger Socket #1
│   │   └─ Listening for: busLocationUpdate, stopUpdate, etaUpdate, notification
│   │
│   ├── Passenger Socket #2
│   │   └─ Listening for: busLocationUpdate, stopUpdate, etaUpdate, notification
│   │
│   ├── Admin Socket #3
│   │   └─ Listening for: (same events, full visibility)
│   │
│   └─ Broadcast from backend:
│       ├─ Every 15-30s: busLocationUpdate (from Redis cache)
│       ├─ When bus reaches stop: stopUpdate
│       ├─ When ETA changes: etaUpdate
│       └─ On events: notification (arrival, delays, etc)
│
├── Room: route:507f1f77bcf86cd799439022
│   │
│   ├── Passenger Socket (subscribed to route)
│   │   └─ Listening for: busLocationUpdate (all buses on route)
│   │
│   └─ Broadcast:
│       └─ Route-level events (all buses on this route)
│
└── Room: bus:507f1f77bcf86cd799439033
    │
    ├── Passenger Socket (tracking this bus)
    │   └─ Listening for: busLocationUpdate (this bus only)
    │
    └─ Broadcast:
        └─ Bus-specific events

CRITICAL RULES:
═════════════════════════════════════════════════════════════

✓ ALLOWED:
  - Passenger joins trip room
  - Passenger joins route room
  - Passenger joins bus room
  - Passenger receives broadcasts
  - Admin receives broadcasts
  - Admin can join any room

✗ BLOCKED:
  - Driver cannot connect to WebSocket
  - Driver socket connection is rejected
  - Driver cannot emit location via socket
  - Driver cannot join any room

BROADCAST FLOW:
═════════════════════════════════════════════════════════════

Backend (periodic, from Redis cache):
  1. Get latest location: Redis.get(`location:trip_${tripId}`)
  2. Format broadcast payload
  3. Emit to room: io.to(`trip:${tripId}`).emit('busLocationUpdate', data)
  4. All subscribers in room receive update
  5. Passenger app updates UI with new location
```

---

## Error Handling Flow

```
REQUEST RECEIVED
    ↓
    ├─ Missing JWT → 401 Unauthorized
    ├─ Invalid JWT signature → 401 Unauthorized
    ├─ JWT expired → 401 Unauthorized
    ├─ Non-driver role → 403 Forbidden
    │
    ├─ Invalid request format → 400 Bad Request
    ├─ Missing required fields → 400 Bad Request
    ├─ Empty locations array → 400 Bad Request
    ├─ > 100 locations → 400 Bad Request
    │
    ├─ Rate limit exceeded → 429 Too Many Requests
    │
    ├─ Duplicate nonce → 400 Bad Request (replay attack)
    │
    ├─ Coordinate out of bounds → 400 Bad Request
    ├─ Invalid timestamp → 400 Bad Request
    ├─ All locations invalid → 400 Bad Request
    │
    └─ Server error → 500 Internal Server Error

RESPONSE WITH DETAILS:
════════════════════════════════════════════════════════════

{
  "success": false,
  "message": "Error description",
  "details": {
    "validCount": 8,        // Locations that passed validation
    "invalidCount": 2,      // Locations that failed validation
    "duplicateCount": 1,    // Exact duplicates filtered
    "errors": [
      "Latitude out of bounds at index 1: 95.5",
      "Invalid timestamp at index 5: 'not-a-date'"
    ]
  }
}
```

---

## Migration Timeline

```
WEEK 1: SETUP & TESTING
┌─────────────────────────────────────────┐
│ Mon: Deploy backend to staging          │
│ Tue: Run integration tests              │
│ Wed: Load test (1000 drivers)           │
│ Thu: Performance review                 │
│ Fri: Sign off on staging                │
└─────────────────────────────────────────┘

WEEK 2: SOFT ROLLOUT (10%)
┌─────────────────────────────────────────┐
│ Mon: Deploy to production (batch enabled)
│ Tue: Monitor 10% of drivers             │
│ Wed: Check error rates & performance    │
│ Thu: Scale to 25% if healthy            │
│ Fri: Review metrics                     │
└─────────────────────────────────────────┘

WEEK 3: FULL ROLLOUT (100%)
┌─────────────────────────────────────────┐
│ Mon: Driver app update released         │
│ Tue: 50% of drivers migrated            │
│ Wed: 75% of drivers migrated            │
│ Thu: 100% of drivers migrated           │
│ Fri: Monitor stability                  │
└─────────────────────────────────────────┘

WEEK 4: CLEANUP
┌─────────────────────────────────────────┐
│ Mon: Remove driver socket handlers      │
│ Tue: Monitor for errors                 │
│ Wed: Performance optimization           │
│ Thu: Documentation finalization         │
│ Fri: Post-mortem & learnings            │
└─────────────────────────────────────────┘
```
