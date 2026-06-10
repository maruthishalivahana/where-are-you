import { Request, Response } from 'express';
import { verifyRefreshToken } from '../../utils/generateTokens';
import { generateTokens } from '../../utils/generateTokens';
import { setAuthCookies, clearAuthCookies } from '../../utils/cookies';
import { User } from '../user/user.model';
import { Driver } from '../driver/driver.model';
import { tripService } from '../trip/trip.service';
import { DeviceToken } from '../notification/deviceToken.model';

export const refreshTokenController = async (req: Request, res: Response): Promise<void> => {
    // Try to get refresh token from cookie first, then from body
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!refreshToken) {
        res.status(401).json({ message: 'Refresh token required' });
        return;
    }

    // Verify refresh token
    const payload = verifyRefreshToken(refreshToken);

    // Generate new tokens
    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = generateTokens({
        sub: payload.sub,
        organizationId: payload.organizationId,
        role: payload.role,
    });

    // Set new cookies
    setAuthCookies(res, newAccessToken, newRefreshToken);

    res.status(200).json({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
    });
};

export const logoutController = async (req: Request, res: Response): Promise<void> => {
    clearAuthCookies(res);
    res.status(200).json({ message: 'Logged out successfully' });
};

export const logoutUserController = async (req: Request, res: Response): Promise<void> => {
    try {
        if (req.user?.sub && req.user.organizationId) {
            await User.findOneAndUpdate(
                { _id: req.user.sub, organizationId: req.user.organizationId },
                { fcmToken: '' }
            );
            await DeviceToken.updateMany(
                { userId: req.user.sub } as any,
                { isActive: false }
            );
        }

        clearAuthCookies(res);
        res.status(200).json({ message: 'User logged out successfully' });
    } catch (error) {
        clearAuthCookies(res);
        res.status(200).json({ message: 'User logged out successfully' });
    }
};

export const logoutDriverController = async (req: Request, res: Response): Promise<void> => {
    try {
        if (req.user?.sub && req.user.organizationId) {
            await Driver.findOneAndUpdate(
                { _id: req.user.sub, organizationId: req.user.organizationId },
                { isTracking: false },
                { new: true }
            );

            await tripService.completeActiveTripForDriver(req.user.sub, req.user.organizationId);
        }

        clearAuthCookies(res);
        res.status(200).json({ message: 'Driver logged out successfully' });
    } catch (error) {
        clearAuthCookies(res);
        res.status(200).json({ message: 'Driver logged out successfully' });
    }
};
