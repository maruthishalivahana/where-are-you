import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import cors from 'cors';
import { connectDB } from './config/db.config';
import { getRedisClient } from './config/redis.config';
import { ENV } from './config/env.config';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { authRouter } from './modules/auth/auth.routes';
import { busRouter } from './modules/bus/bus.routes';
import { driverRouter } from './modules/driver/driver.routes';
import { routeRouter } from './modules/route/route.routes';
import { stopRouter } from './modules/stop/stop.routes';
import { userRouter } from './modules/user/user.routes';
import { userAppRouter } from './modules/user/user.app.routes';
import { trackingRouter } from './modules/tracking/tracking.routes';
import { tripRouter } from './modules/trip/trip.routes';
import { initSocket } from './websocket/socket.server';
import { notificationRouter } from './modules/notification/notification.routes';
import { deviceTokenRoutes } from './modules/notification/deviceToken.routes';
import { initializeNotificationListeners } from './modules/notification/notification.events';
import { routeDebugRouter } from './modules/route/route.debug.routes';
import { planRouter } from './modules/plan/plan.routes';
import { paymentRouter } from './modules/payment/payment.routes';
import { paymentWebhookRouter } from './modules/payment/payment.webhook.routes';
import { simulationRouter } from './modules/notification/simulation.routes';
import { locationRouter } from './modules/location/location.routes';

const app = express();

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '');

const configuredOrigins = new Set([
    ...ENV.FRONTEND_URLS.map(normalizeOrigin),
    ...ENV.MOBILE_APP_ORIGINS.map(normalizeOrigin),
]);

const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) {
        return true;
    }

    if (ENV.NODE_ENV !== 'production') {
        return true;
    }

    const normalizedOrigin = normalizeOrigin(origin);
    if (normalizedOrigin === 'null') {
        return true;
    }

    if (configuredOrigins.size === 0) {
        return true;
    }

    return configuredOrigins.has(normalizedOrigin);
};

app.disable('x-powered-by');

app.use(
    cors({
        origin: (origin, callback) => {
            if (isAllowedOrigin(origin)) {
                callback(null, true);
                return;
            }

            logger.warn(`CORS blocked for origin: ${origin || 'none'}`);
            callback(new Error(`CORS blocked for origin: ${origin}`));
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
        credentials: true,
        maxAge: 86400,
        optionsSuccessStatus: 204,
    })
);

app.use(
    express.json({
        limit: '1mb',
        verify: (req, _res, buf) => {
            (req as any).rawBody = buf;
        },
    })
);
app.use(cookieParser());

app.get('/', (_req, res) => {
    res.status(200).json({ message: 'Where Are You backend is running' });
});

app.get('/health', (_req, res) => {
    res.status(200).json({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

app.use((req, res, next) => {
    const startedAt = Date.now();

    res.on('finish', () => {
        const durationMs = Date.now() - startedAt;
        logger.info(
            `${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`
        );
    });

    next();
});

app.use('/api/auth', authRouter);
app.use('/api/admin/plans', planRouter);
app.use('/api/admin/plans', paymentRouter);
app.use('/api/webhooks', paymentWebhookRouter);
app.use('/api/buses', busRouter);
app.use('/api/driver', driverRouter);
app.use('/api/admin/routes', routeRouter);
app.use('/api/admin', stopRouter);
app.use('/api/admin/users', userRouter);
app.use('/api/tracking', trackingRouter);
app.use('/api/trip', tripRouter);
app.use('/api/user', userAppRouter);
app.use('/api/user/notifications', notificationRouter);
app.use('/api/notifications', deviceTokenRoutes);
app.use('/api/location', locationRouter);
app.use('/api/debug', routeDebugRouter);
app.use('/api/debug/notifications', simulationRouter);

app.use(notFoundHandler);
app.use(errorHandler);

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    process.exit(1);
});

connectDB()
    .then(() => {
        // Initialize Redis after DB connection
        try {
            getRedisClient();
            logger.info('Redis initialized successfully');
        } catch (error) {
            logger.warn('Redis initialization warning (non-critical)', error);
        }

        const server = createServer(app);
        initSocket(server);

        // Initialize notification event listeners
        initializeNotificationListeners();

        const port = Number(ENV.PORT) || 3000;
        const host = '0.0.0.0';

        server.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                logger.error(
                    `Port ${port} is already in use. Stop the existing process or set a different PORT in .env.`
                );
                process.exit(1);
                return;
            }

            logger.error(`Server failed to start on http://${host}:${port}`, error);
            process.exit(1);
        });

        server.listen(port, host, () => {
            logger.info(`Server is running on http://${host}:${port}`);
            logger.info(`Environment: ${ENV.NODE_ENV}`);
            logger.info(`Tracking architecture: HTTP batch uploads + Redis caching (drivers) + WebSocket broadcast (passengers only)`);
        });
    })
    .catch((error) => {
        logger.error('Database connection failed. Server startup aborted.', error);
        process.exit(1);
    });