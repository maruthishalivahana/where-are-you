import jwt from 'jsonwebtoken';
import { ExtendedError, Socket } from 'socket.io';
import { JWT_CONFIG } from '../config/jwt.config';
import { AuthenticatedRequestUser } from '../modules/auth/auth.types';
import { logger } from '../utils/logger';
import { ROLES } from '../constants/roles';

const parseTokenFromHandshake = (socket: Socket): string | null => {
    const authToken = socket.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
        return authToken.trim();
    }

    const queryToken = socket.handshake.query?.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
        return queryToken.trim();
    }

    const authorization = socket.handshake.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
        return authorization.replace('Bearer ', '').trim();
    }

    const cookieHeader = socket.handshake.headers.cookie;
    if (typeof cookieHeader === 'string') {
        const cookies = cookieHeader.split(';').map((entry) => entry.trim());
        const accessTokenCookie = cookies.find((entry) => entry.startsWith('accessToken='));
        if (accessTokenCookie) {
            return decodeURIComponent(accessTokenCookie.split('=').slice(1).join('='));
        }
    }

    return null;
};

/**
 * REFACTORED Socket Authentication
 * 
 * CRITICAL CHANGE: Drivers are NO LONGER ALLOWED to connect via WebSocket
 * 
 * ALLOWED ROLES:
 * - PASSENGER (receive location/ETA updates)
 * - ADMIN (monitoring & management)
 * 
 * BLOCKED ROLES:
 * - DRIVER (must use HTTP batch API instead)
 * 
 * WHY:
 * - WebSocket connections are unreliable for drivers (iOS background mode)
 * - Drivers now upload locations via HTTP batch API
 * - WebSockets are only for downstream consumers (passengers)
 */
export const authenticateSocket = (
    socket: Socket,
    next: (err?: ExtendedError) => void
): void => {
    const handshakeInfo = `socket=${socket.id}, address=${socket.handshake.address || 'unknown'}, origin=${socket.handshake.headers.origin || 'none'}`;

    try {
        const token = parseTokenFromHandshake(socket);

        if (!token) {
            logger.warn(`Socket authentication failed (missing token): ${handshakeInfo}`);
            next(new Error('Unauthorized: missing token'));
            return;
        }

        const decoded = jwt.verify(token, JWT_CONFIG.SECRET) as AuthenticatedRequestUser;

        // CRITICAL: Block driver socket connections
        if (decoded.role === ROLES.DRIVER) {
            logger.warn(
                `Socket connection rejected for driver: ${decoded.sub} (drivers must use HTTP batch API)`
            );
            next(new Error('Unauthorized: Drivers must use HTTP batch API'));
            return;
        }

        // Only allow passengers and admins
        if (![ROLES.USER, ROLES.ADMIN].includes(decoded.role)) {
            logger.warn(`Socket connection rejected for role: ${decoded.role}`);
            next(new Error('Unauthorized: This role cannot use WebSocket'));
            return;
        }

        socket.data.user = {
            sub: decoded.sub,
            organizationId: decoded.organizationId,
            role: decoded.role,
        };

        logger.info(
            `Socket authenticated successfully: ${socket.id}, role=${decoded.role}`
        );
        next();
    } catch (_error) {
        logger.warn(`Socket authentication failed (invalid/expired token): ${handshakeInfo}`);
        next(new Error('Unauthorized: invalid or expired token'));
    }
};
