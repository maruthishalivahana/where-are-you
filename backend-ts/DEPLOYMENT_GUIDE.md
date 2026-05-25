# HTTP Batch Upload - Deployment & Setup Guide

## Environment Configuration

Add these Redis variables to your `.env` file:

```env
# Redis Configuration
REDIS_HOST=localhost           # Redis server hostname
REDIS_PORT=6379               # Redis server port (default: 6379)
REDIS_PASSWORD=               # Redis password (leave empty if no auth)
REDIS_DB=0                    # Redis database number (0-15)

# Optional: Use Redis URL instead of individual vars
# REDIS_URL=redis://localhost:6379

# Existing configs (unchanged)
PORT=3000
MONGO_URI=mongodb://localhost:27017/where-you-are
NODE_ENV=development
JWT_SECRET=your-secret-key
# ... rest of your env vars
```

---

## Local Development Setup

### 1. Install Dependencies

```bash
cd backend-ts

# Install new Redis dependency
npm install ioredis

# Or if using yarn
yarn add ioredis

# Verify installation
npm list ioredis
```

### 2. Start Redis Locally

**Option A: Docker (Recommended)**
```bash
# Start Redis container
docker run -d \
  --name redis-tracking \
  -p 6379:6379 \
  redis:7-alpine

# Verify Redis is running
redis-cli ping
# Response: PONG
```

**Option B: macOS (Homebrew)**
```bash
# Install Redis
brew install redis

# Start Redis service
redis-server
```

**Option C: Ubuntu/Linux**
```bash
# Install Redis
sudo apt-get install redis-server

# Start Redis service
sudo systemctl start redis-server
```

### 3. Create `.env.local`

```env
# Database
MONGO_URI=mongodb://localhost:27017/where-you-are

# Redis (local)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=0

# Server
PORT=3000
NODE_ENV=development

# JWT
JWT_SECRET=dev-secret-key-change-in-production
JWT_EXPIRES_IN=7d
REFRESH_TOKEN_SECRET=dev-refresh-secret-key
REFRESH_TOKEN_EXPIRES_IN=30d

# Google Maps
GOOGLE_MAPS_API_KEY=

# Firebase
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

# Tracking
TRACKING_TIMEZONE=Asia/Kolkata
TRACKING_UPDATE_INTERVAL_MS=5000
TRACKING_MOVEMENT_THRESHOLD_METERS=10

# CORS
FRONTEND_URL=http://localhost:3000
FRONTEND_DRIVER_USER_URL=http://localhost:3001
```

### 4. Run Development Server

```bash
# Start with nodemon (watches for changes)
npm run dev

# You should see:
# Redis connected
# Server is running on http://0.0.0.0:3000
# Tracking architecture: HTTP batch uploads + Redis caching...
```

### 5. Verify Setup

```bash
# Test health endpoint
curl http://localhost:3000/health

# Test Redis connection
redis-cli
> PING
PONG

# Test batch upload endpoint (requires JWT token)
curl -X POST http://localhost:3000/api/tracking/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "tripId": "test_trip",
    "driverId": "test_driver",
    "busId": "test_bus",
    "batchTimestamp": "2026-05-24T12:00:00Z",
    "nonce": "unique-nonce-123",
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
    ]
  }'
```

---

## Production Deployment

### 1. Redis Deployment Options

#### Option A: AWS ElastiCache (Recommended for Production)
```bash
# Create ElastiCache Redis cluster
aws elasticache create-cache-cluster \
  --cache-cluster-id where-you-are-tracking \
  --engine redis \
  --cache-node-type cache.t3.micro \
  --engine-version 7.0 \
  --num-cache-nodes 1 \
  --auto-failover-enabled

# Note cluster endpoint and configure in env
```

**Environment**:
```env
REDIS_HOST=where-you-are-tracking.xxxxx.ng.0001.use1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_PASSWORD=your-auth-token
```

#### Option B: Redis Cloud (Simple)
```
1. Go to https://app.redis.com/
2. Create new database
3. Get connection string
4. Configure in env
```

**Environment**:
```env
REDIS_HOST=redis-xxxxx.c123.us-east-1-2.ec2.cloud.redislabs.com
REDIS_PORT=12345
REDIS_PASSWORD=your-password
```

#### Option C: Self-Hosted (Advanced)
```bash
# Use managed Redis provider or
# Deploy Redis on dedicated server
# with replication and persistence

# Enable AOF persistence
appendonly yes
appendfsync everysec

# Enable RDB snapshots
save 900 1
save 300 10
save 60 10000
```

### 2. Database Indexes (Production)

Before deploying to production, create all necessary indexes:

```bash
# Connect to MongoDB
mongosh your-production-db

# Run index creation
use where-you-are;

// Tracking indexes
db.locationlogs.createIndex({ driverId: 1, timestamp: -1 });
db.locationlogs.createIndex({ tripId: 1, timestamp: -1 });
db.locationlogs.createIndex({ busId: 1, timestamp: -1 });
db.locationlogs.createIndex({ organizationId: 1, timestamp: -1 });
db.locationlogs.createIndex({ location: "2dsphere", timestamp: -1 });
db.locationlogs.createIndex({ organizationId: 1, tripId: 1, timestamp: -1 });

// Verify indexes
db.locationlogs.getIndexes();
```

### 3. Production Environment Variables

```env
# Server
PORT=3000
NODE_ENV=production

# Database
MONGO_URI=mongodb+srv://user:password@prod-cluster.mongodb.net/where-you-are?retryWrites=true&w=majority

# Redis (ElastiCache or Redis Cloud)
REDIS_HOST=prod-redis-endpoint.xxxxx
REDIS_PORT=6379
REDIS_PASSWORD=strong-password-here
REDIS_DB=0

# JWT
JWT_SECRET=generate-strong-random-secret
JWT_EXPIRES_IN=7d
REFRESH_TOKEN_SECRET=generate-another-strong-random-secret
REFRESH_TOKEN_EXPIRES_IN=30d

# Google Maps
GOOGLE_MAPS_API_KEY=your-api-key

# Firebase
FIREBASE_PROJECT_ID=your-project
FIREBASE_CLIENT_EMAIL=your-email
FIREBASE_PRIVATE_KEY=your-key

# URLs
FRONTEND_URL=https://app.where-you-are.com
FRONTEND_DRIVER_USER_URL=https://driver.where-you-are.com

# Tracking
TRACKING_TIMEZONE=Asia/Kolkata
TRACKING_UPDATE_INTERVAL_MS=10000
TRACKING_MOVEMENT_THRESHOLD_METERS=10

# CORS Origins
FRONTEND_URLS=https://app.where-you-are.com,https://admin.where-you-are.com
MOBILE_APP_ORIGINS=https://api.where-you-are.com
```

### 4. Docker Deployment

Create `Dockerfile`:
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
```

Create `docker-compose.yml`:
```yaml
version: '3.8'
services:
  backend:
    build: .
    ports:
      - "3000:3000"
    environment:
      - MONGO_URI=${MONGO_URI}
      - REDIS_HOST=${REDIS_HOST}
      - REDIS_PORT=${REDIS_PORT}
      - REDIS_PASSWORD=${REDIS_PASSWORD}
      - JWT_SECRET=${JWT_SECRET}
      - NODE_ENV=production
    depends_on:
      - redis
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    restart: unless-stopped

volumes:
  redis-data:
```

Deploy:
```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f backend

# Stop
docker-compose down
```

### 5. Performance Tuning

#### Redis Configuration
```conf
# /etc/redis/redis.conf

# Memory management
maxmemory 2gb
maxmemory-policy allkeys-lru

# Persistence
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfsync everysec

# Networking
timeout 0
tcp-keepalive 300

# Slow log
slowlog-log-slower-than 10000  # microseconds
slowlog-max-len 128
```

#### MongoDB Configuration
```conf
# Ensure indexes are built
# Monitor query performance
```

#### Node.js Configuration
```bash
# Increase file descriptors
ulimit -n 65536

# Tune V8 garbage collection
node --max-old-space-size=4096 dist/server.js
```

### 6. Monitoring & Logging

#### Redis Monitoring
```bash
# Monitor real-time commands
redis-cli monitor

# Check memory usage
redis-cli INFO memory

# Check connected clients
redis-cli CLIENT LIST

# Check slow queries
redis-cli SLOWLOG GET 10
```

#### Application Monitoring
```typescript
// Add to server.ts
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty'
  }
});

// Log Redis operations
redisClient.on('command', (command) => {
  logger.debug({ command }, 'Redis command');
});
```

#### Metrics
```typescript
// Track key metrics
import { StatsD } from 'node-dogstatsd';

const statsd = new StatsD({
  host: 'localhost',
  port: 8125,
  prefix: 'where_you_are.'
});

// Batch processing
statsd.timing('batch.processing_time_ms', processingTime);
statsd.gauge('batch.locations_processed', count);
statsd.increment('batch.uploads');

// Redis operations
statsd.timing('redis.setex_ms', latency);
statsd.increment('redis.cache_hit');
statsd.increment('redis.cache_miss');

// Database
statsd.timing('database.bulk_insert_ms', insertTime);
statsd.gauge('database.insert_count', count);
```

### 7. Scaling Strategy

#### Horizontal Scaling (Multiple Backend Instances)
```yaml
# AWS Load Balancer → Multiple backend instances
# All instances share same Redis & MongoDB

# Session-less HTTP is perfect for this
# Just ensure all instances use same Redis cluster
```

#### Redis Cluster (For High Traffic)
```bash
# Redis Cluster mode (multiple nodes)
# - Automatic failover
# - Horizontal scalability
# - Built-in replication

# Configure in env:
REDIS_CLUSTER_NODES=node1:6379,node2:6379,node3:6379
```

#### Database Sharding (When needed)
```bash
# MongoDB Sharding by organizationId
# - Each organization's data on separate shard
# - Reduces single database load
# - Complex - implement only at scale
```

---

## Rollout Strategy

### Week 1: Staging & Testing
```bash
# Deploy to staging environment
# Run full test suite
# Load test with 1000 mock drivers
# Test replay attack prevention
# Monitor Redis memory
```

### Week 2: Soft Rollout (10% of users)
```bash
# Deploy to production
# Enable batch endpoint alongside old socket endpoint
# Monitor error rates
# Watch database load
# Check Redis cache hit rates
```

### Week 3: Full Rollout
```bash
# Migrate remaining 90% of users
# Monitor system stability
# Collect performance data
# Document migration success
```

### Week 4: Cleanup
```bash
# Remove old socket-based driver handlers
# Remove deprecated endpoint (or keep for API compat)
# Optimize based on real-world data
```

---

## Troubleshooting

### Redis Connection Issues
```
Error: Connection refused to Redis

Solution:
1. Verify Redis is running: redis-cli ping
2. Check REDIS_HOST and REDIS_PORT
3. Check network access / firewall
4. Check Redis auth credentials
```

### Rate Limit Issues
```
Error: Rate limit exceeded (max 10 batches per minute)

Solution:
1. This is expected - driver app should batch locations
2. If legitimate, increase limit in batchTrackingService
3. Check driver app batching interval (should be 10-15s)
```

### Spoofing Detection False Positives
```
Error: Suspicious speed detected

Solution:
1. Review location timestamps for accuracy
2. Check if driver has unrealistic speeds (highway?)
3. If false positive, logs are still recorded (not rejected)
4. Adjust MAX_SPEED_MPS if needed
```

### Memory Issues
```
Error: Redis out of memory

Solution:
1. Monitor Redis memory: redis-cli INFO memory
2. Check TTL configuration (should be 30-120s max)
3. Implement TTL on all keys
4. Increase Redis memory or reduce cache size
```

---

## Verification Checklist

- [ ] Redis installed and running
- [ ] `ioredis` dependency installed
- [ ] `.env` file configured with Redis credentials
- [ ] Database indexes created
- [ ] Server starts without errors
- [ ] Health endpoint responds (curl http://localhost:3000/health)
- [ ] Redis connection verified (redis-cli PING)
- [ ] JWT authentication working
- [ ] Batch upload endpoint responds to request
- [ ] Rate limiting working
- [ ] Replay attack prevention verified
- [ ] WebSocket broadcasts to passengers only
- [ ] Driver socket connections rejected with appropriate error

---

## Next Steps

1. **Test locally** with development Redis
2. **Deploy to staging** with ElastiCache Redis
3. **Load test** with 1000+ concurrent drivers
4. **Monitor metrics** for 1 week
5. **Gradually roll out** to production
6. **Document learnings** and optimizations
