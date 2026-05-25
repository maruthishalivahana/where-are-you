# Where You Are — Backend API

Base URL: `http://localhost:3000`

All protected routes require:
```
Authorization: Bearer <token>
```

---

## Bus Status Model (Canonical)

Backend now exposes three canonical status fields for every bus response:

- `fleetStatus`: `IN_SERVICE` | `OUT_OF_SERVICE` | `MAINTENANCE`
- `tripStatus`: `NOT_SCHEDULED` | `TRIP_NOT_STARTED` | `ON_TRIP` | `COMPLETED` | `DELAYED` | `CANCELLED` | `MAINTENANCE_HOLD`
- `trackingStatus`: `RUNNING` | `IDLE` | `OFFLINE` | `NO_SIGNAL`

Legacy compatibility is preserved:

- `status` is still returned for old clients.
- mapping: `IN_SERVICE` -> `active`, `OUT_OF_SERVICE` -> `inactive`, `MAINTENANCE` -> `active`

Default/migration behavior for existing buses:

- no route assigned => `tripStatus = NOT_SCHEDULED`
- maintenance mode enabled => `tripStatus = MAINTENANCE_HOLD`
- route assigned (not maintenance) => `tripStatus = TRIP_NOT_STARTED`
- missing telemetry timestamp/position => `trackingStatus = NO_SIGNAL`

Configurable thresholds (`.env`):

- `TRACKING_STALE_THRESHOLD_MS` (default `60000`)
- `TRACKING_RUNNING_SPEED_MPS` (default `1.5`)
- `TRIP_DELAY_THRESHOLD_MINUTES` (default `5`)

---

## Live Route Stop Timeline Metadata (Time-Based)

Live route payloads now include backend-computed, time-first stop timeline fields.

Per-stop contract (primary fields):

- `id`
- `name`
- `sequenceOrder`
- `isPassed`
- `etaFromCurrentSeconds`
- `etaFromCurrentText` (`Arriving Now`, `In <1 min`, `In N mins`)
- `segmentEtaSeconds`
- `segmentEtaText`
- `arrivalClockTimeText` (`h:mm AM/PM`)
- `departedClockTimeText` (for passed stops when available)
- `status` (`passed` | `current` | `upcoming`)
- `leftSubLabel`
- `rightPrimaryLabel`
- `rightSecondaryLabel` (`CURRENT` only for current stop)

Label behavior:

- `passed` stop: `leftSubLabel = Departed h:mm AM/PM`, `rightPrimaryLabel = Passed`
- `current` stop: `leftSubLabel = Arriving Now`, `rightPrimaryLabel = <current local clock time>`, `rightSecondaryLabel = CURRENT`
- `upcoming` stop: `leftSubLabel = In X mins`, `rightPrimaryLabel = <arrival clock time>`

Timezone behavior:

- Clock labels use route timezone when provided.
- Fallback timezone is `TRACKING_TIMEZONE` (or `APP_TIMEZONE`), then `UTC`.

Migration / backward compatibility:

- Existing distance fields are still returned for compatibility (`distanceFromCurrentMeters`, `distanceFromCurrentText`, `segmentDistanceMeters`, `segmentDistanceText`).
- New clients should treat time-based fields above as the source of truth for timeline rows.

Socket alignment:

- `stopUpdate` keeps legacy keys and now includes optional `timeline.currentStop` and `timeline.nextStop` objects.
- `etaUpdate` includes route ETA summary and `stops` with full time-based timeline metadata.

---

## Auth APIs

### 1. Admin Signup
**POST** `/api/auth/admin/signup`

**Request Body:**
```json
{
  "name": "John Admin",
  "organizationName": "BVRIT College",
  "email": "admin@bvrit.ac.in",
  "password": "secret123"
}
```

**Response `201`:**
```json
{
  "token": "<jwt>",
  "admin": {
    "id": "65f1a...",
    "name": "John Admin",
    "email": "admin@bvrit.ac.in",
    "organization": {
      "id": "65f1b...",
      "name": "BVRIT College",
      "slug": "bvrit-college"
    }
  }
}
```

---

### 2. Admin Login
**POST** `/api/auth/admin/login`

**Request Body:**
```json
{
  "email": "admin@bvrit.ac.in",
  "password": "secret123"
}
```

**Response `200`:**
```json
{
  "token": "<jwt>",
  "admin": {
    "id": "65f1a...",
    "name": "John Admin",
    "email": "admin@bvrit.ac.in",
    "organization": {
      "id": "65f1b...",
      "name": "BVRIT College",
      "slug": "bvrit-college"
    }
  }
}
```

---

### 3. Member Login (User / Driver)
**POST** `/api/auth/member/login`

**Request Body:**
```json
{
  "role": "user",
  "memberId": "STU-001",
  "password": "secret123",
  "organizationSlug": "bvrit-college"
}
```
> `role` must be `"user"` or `"driver"`. `organizationSlug` is optional — required only if `memberId` exists across multiple organizations.

**Response `200`:**
```json
{
  "token": "<jwt>",
  "member": {
    "id": "65f1c...",
    "role": "user",
    "name": "Alice",
    "memberId": "STU-001"
  }
}
```

---

### 4. Create User (Admin only)
**POST** `/api/auth/admin/users` 🔒 Admin

**Request Body:**
```json
{
  "name": "Alice",
  "memberId": "STU-001",
  "password": "secret123"
}
```

**Response `201`:**
```json
{
  "user": {
    "id": "65f1c...",
    "name": "Alice",
    "memberId": "STU-001"
  }
}
```

---

### 5. Create Driver (Admin only)
**POST** `/api/auth/admin/drivers` 🔒 Admin

**Request Body:**
```json
{
  "name": "Kumar",
  "memberId": "EMP-001",
  "password": "secret123"
}
```

**Response `201`:**
```json
{
  "driver": {
    "id": "65f1d...",
    "name": "Kumar",
    "memberId": "EMP-001"
  }
}
```

---

## Bus APIs 🔒 Admin

### 6. Create Bus
**POST** `/api/buses`

**Request Body:**
```json
{
  "numberPlate": "TS09AB1234",
  "routeId": "65f2a..."
}
```

**Response `201`:**
```json
{
  "bus": {
    "id": "65f3a...",
    "numberPlate": "TS09AB1234",
    "fleetStatus": "OUT_OF_SERVICE",
    "tripStatus": "NOT_SCHEDULED",
    "trackingStatus": "NO_SIGNAL",
    "status": "active",
    "routeId": "65f2a...",
    "driverId": null
  }
}
```

---

### 7. Get All Buses
**GET** `/api/buses`

No body required.

**Response `200`:**
```json
{
  "buses": [
    {
      "id": "65f3a...",
      "numberPlate": "TS09AB1234",
      "fleetStatus": "IN_SERVICE",
      "tripStatus": "TRIP_NOT_STARTED",
      "trackingStatus": "IDLE",
      "status": "active",
      "driverId": null,
      "routeId": "65f2a...",
      "routeName": "Route 1"
    }
  ]
}
```

---

### 8. Get Bus by ID
**GET** `/api/buses/:busId`

No body required.

**Response `200`:**
```json
{
  "bus": {
    "id": "65f3a...",
    "numberPlate": "TS09AB1234",
    "fleetStatus": "IN_SERVICE",
    "tripStatus": "ON_TRIP",
    "trackingStatus": "RUNNING",
    "status": "active",
    "currentLat": 17.3850,
    "currentLng": 78.4867,
    "lastUpdated": "2026-02-23T10:00:00.000Z"
  }
}
```

---

### 9. Update Bus Driver
**PUT** `/api/buses/:busId/driver`

**Request Body:**
```json
{
  "driverId": "65f1d..."
}
```
> Pass `null` to unassign the driver.

**Response `200`:**
```json
{
  "bus": {
    "id": "65f3a...",
    "numberPlate": "TS09AB1234",
    "driverId": "65f1d..."
  }
}
```

---

### 10. Delete Bus
**DELETE** `/api/buses/:busId`

No body required.

**Response `200`:**
```json
{
  "message": "Bus deleted successfully"
}
```

---

## Driver APIs 🔒 Driver

### 11. Get My Details
**GET** `/api/driver/me`

No body required.

**Response `200`:**
```json
{
  "id": "65f1d...",
  "name": "Kumar",
  "employeeId": "EMP-001",
  "organizationId": "65f1b...",
  "assignedBus": {
    "id": "65f3a...",
    "numberPlate": "TS09AB1234",
    "fleetStatus": "IN_SERVICE",
    "tripStatus": "ON_TRIP",
    "trackingStatus": "RUNNING",
    "status": "active",
    "currentLat": 17.3850,
    "currentLng": 78.4867
  }
}
```

---

### 12. Get My Bus
**GET** `/api/driver/my-bus`

No body required.

**Response `200`:**
```json
{
  "id": "65f3a...",
  "numberPlate": "TS09AB1234",
  "fleetStatus": "IN_SERVICE",
  "tripStatus": "ON_TRIP",
  "trackingStatus": "RUNNING",
  "status": "active",
  "currentLat": 17.3850,
  "currentLng": 78.4867,
  "lastUpdated": "2026-02-23T10:00:00.000Z"
}
```

---

## Bus Workflow APIs (Admin)

### Toggle Maintenance Mode
**PATCH** `/api/buses/:busId/maintenance`

**Request Body:**
```json
{
  "maintenanceMode": true
}
```

Effects:

- when `true`: `fleetStatus = MAINTENANCE`, `tripStatus = MAINTENANCE_HOLD`
- when `false`: returns to `TRIP_NOT_STARTED` (if route assigned) or `NOT_SCHEDULED`

### Trip Event Transitions
**POST** `/api/buses/:busId/trip-events`

**Request Body examples:**

```json
{ "eventType": "trip_started" }
```

```json
{ "eventType": "trip_completed" }
```

```json
{ "eventType": "trip_cancelled" }
```

```json
{ "eventType": "trip_delayed", "delayMinutes": 15 }
```

```json
{ "eventType": "transition", "nextTripStatus": "TRIP_NOT_STARTED" }
```

Transition guardrails return explicit `400` messages for invalid transitions (for example, `ON_TRIP -> NOT_SCHEDULED` without route removal).

---

## Route APIs 🔒 Admin

### 13. Create Route
**POST** `/api/admin/routes`

**Request Body:**
```json
{
  "name": "Sangareddy to BVRIT",
  "startLat": 17.6246,
  "startLng": 78.0873,
  "endLat": 17.5150,
  "endLng": 78.2627
}
```

**Response `201`:**
```json
{
  "route": {
    "id": "65f2a...",
    "name": "Sangareddy to BVRIT",
    "encodedPolyline": "abc123...",
    "totalDistanceMeters": 24500,
    "estimatedDurationSeconds": 2100,
    "isActive": true,
    "createdAt": "2026-02-23T10:00:00.000Z",
    "updatedAt": "2026-02-23T10:00:00.000Z"
  }
}
```

---

### 14. Get All Routes
**GET** `/api/admin/routes`

No body required.

**Response `200`:**
```json
{
  "routes": [
    {
      "id": "65f2a...",
      "name": "Sangareddy to BVRIT",
      "encodedPolyline": "abc123...",
      "totalDistanceMeters": 24500,
      "estimatedDurationSeconds": 2100,
      "isActive": true,
      "createdAt": "2026-02-23T10:00:00.000Z",
      "updatedAt": "2026-02-23T10:00:00.000Z"
    }
  ]
}
```

---

### 15. Get Route by ID
**GET** `/api/admin/routes/:id`

No body required.

**Response `200`:**
```json
{
  "route": {
    "id": "65f2a...",
    "name": "Sangareddy to BVRIT",
    "encodedPolyline": "abc123...",
    "totalDistanceMeters": 24500,
    "estimatedDurationSeconds": 2100,
    "isActive": true,
    "createdAt": "2026-02-23T10:00:00.000Z",
    "updatedAt": "2026-02-23T10:00:00.000Z"
  }
}
```

---

### 16. Delete Route
**DELETE** `/api/admin/routes/:id`

No body required.

**Response `200`:**
```json
{
  "message": "Route deleted successfully"
}
```

---

## Stop APIs 🔒 Admin

### 17. Create Stop
**POST** `/api/admin/routes/:routeId/stops`

**Request Body:**
```json
{
  "name": "Sangareddy Bus Stand",
  "latitude": 17.6246,
  "longitude": 78.0873,
  "sequenceOrder": 1,
  "radiusMeters": 100
}
```
> `radiusMeters` is optional, defaults to `100`.

**Response `201`:**
```json
{
  "stop": {
    "id": "65f4a...",
    "routeId": "65f2a...",
    "name": "Sangareddy Bus Stand",
    "latitude": 17.6246,
    "longitude": 78.0873,
    "sequenceOrder": 1,
    "radiusMeters": 100,
    "createdAt": "2026-02-23T10:00:00.000Z",
    "updatedAt": "2026-02-23T10:00:00.000Z"
  }
}
```

---

### 18. Get Stops by Route
**GET** `/api/admin/routes/:routeId/stops`

No body required.

**Response `200`:**
```json
{
  "stops": [
    {
      "id": "65f4a...",
      "routeId": "65f2a...",
      "name": "Sangareddy Bus Stand",
      "latitude": 17.6246,
      "longitude": 78.0873,
      "sequenceOrder": 1,
      "radiusMeters": 100
    },
    {
      "id": "65f4b...",
      "routeId": "65f2a...",
      "name": "Patancheru",
      "latitude": 17.5327,
      "longitude": 78.2641,
      "sequenceOrder": 2,
      "radiusMeters": 100
    }
  ]
}
```

---

### 19. Update Stop
**PUT** `/api/admin/stops/:id`

**Request Body** (all fields optional):
```json
{
  "name": "Sangareddy Main Bus Stand",
  "latitude": 17.6250,
  "longitude": 78.0880,
  "sequenceOrder": 1,
  "radiusMeters": 150
}
```

**Response `200`:**
```json
{
  "stop": {
    "id": "65f4a...",
    "routeId": "65f2a...",
    "name": "Sangareddy Main Bus Stand",
    "latitude": 17.6250,
    "longitude": 78.0880,
    "sequenceOrder": 1,
    "radiusMeters": 150,
    "createdAt": "2026-02-23T10:00:00.000Z",
    "updatedAt": "2026-02-23T10:05:00.000Z"
  }
}
```

---

### 20. Delete Stop
**DELETE** `/api/admin/stops/:id`

No body required.

**Response `200`:**
```json
{
  "message": "Stop deleted successfully"
}
```

---

## Error Responses

| Status | Meaning |
|--------|---------|
| `400` | Bad request / validation failed |
| `401` | Missing or invalid token |
| `403` | Forbidden — wrong role |
| `404` | Resource not found |
| `500` | Internal server error |

**Error body:**
```json
{
  "message": "Error description here"
}
```

**Validation error body:**
```json
{
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "invalid email address" }
  ]
}
```
