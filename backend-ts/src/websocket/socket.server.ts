import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { logger } from '../utils/logger';
import { registerSocketHandlers } from './socket.handlers';
import { authenticateSocket } from './socket.auth';
import { ENV } from '../config/env.config';

let io: Server | null = null;

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

export const initSocket = (server: HttpServer): Server => {
	io = new Server(server, {
		cors: {
			origin: (origin, callback) => {
				if (isAllowedOrigin(origin)) {
					callback(null, true);
					return;
				}

				callback(new Error(`Socket CORS blocked for origin: ${origin}`));
			},
			methods: ['GET', 'POST'],
			credentials: true,
		},
	});

	io.use(authenticateSocket);

	io.engine.on('connection_error', (error) => {
		const requestUrl = error.req?.url || 'unknown';
		const originHeader = error.req?.headers?.origin || 'none';
		logger.warn(
			`Socket engine connection error: code=${error.code}, message=${error.message}, url=${requestUrl}, origin=${originHeader}`
		);
	});

	io.on('connection', (socket) => {
		logger.info(`Socket client connected: ${socket.id} (${socket.data.user?.role || 'unknown'})`);
		registerSocketHandlers(socket);
	});

	return io;
};

export const getIO = (): Server => {
	if (!io) {
		throw new Error('Socket.io not initialized');
	}

	return io;
};
