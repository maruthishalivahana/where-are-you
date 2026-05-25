import { logger } from '../utils/logger';
import { calculateDistanceMeters } from '../utils/calculateDistance';

export interface RawLocation {
    latitude: number;
    longitude: number;
    speed?: number;
    heading?: number;
    accuracy?: number;
    batteryLevel?: number;
    timestamp: string;
}

export interface ValidationResult {
    isValid: boolean;
    error?: string;
    isDuplicate?: boolean;
    isSuspicious?: boolean;
}

export interface ValidatedLocation extends RawLocation {
    validatedAt: Date;
}

const MAX_SPEED_MPS = 150 / 3.6;  // 150 km/h
const DUPLICATE_DISTANCE_METERS = 5;
const DUPLICATE_TIME_SECONDS = 5;
const MAX_ACCURACY_METERS = 200;  // Locations with accuracy > 200m are less reliable
const CLOCK_SKEW_SECONDS = 30;

const validateCoordinates = (latitude: number, longitude: number): { isValid: boolean; error?: string } => {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        return {
            isValid: false,
            error: 'Latitude must be between -90 and 90',
        };
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return {
            isValid: false,
            error: 'Longitude must be between -180 and 180',
        };
    }

    return { isValid: true };
};

const validateTimestamp = (timestamp: string): { isValid: boolean; error?: string; date?: Date } => {
    try {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return {
                isValid: false,
                error: 'Timestamp is not a valid ISO date',
            };
        }

        const now = new Date();
        const clockSkewMs = CLOCK_SKEW_SECONDS * 1000;

        // Allow future timestamps (device clock might be ahead)
        if (date.getTime() > now.getTime() + clockSkewMs) {
            return {
                isValid: false,
                error: 'Timestamp is in the future (device clock skew)',
            };
        }

        // Reject very old timestamps (> 24 hours)
        const oneDayMs = 24 * 60 * 60 * 1000;
        if (date.getTime() < now.getTime() - oneDayMs) {
            return {
                isValid: false,
                error: 'Timestamp is too old (> 24 hours)',
            };
        }

        return { isValid: true, date };
    } catch (error) {
        return {
            isValid: false,
            error: 'Failed to parse timestamp',
        };
    }
};

const validateSpeed = (speed: number | undefined): { isValid: boolean; error?: string } => {
    if (speed === undefined) {
        return { isValid: true };
    }

    if (!Number.isFinite(speed) || speed < 0) {
        return {
            isValid: false,
            error: 'Speed must be a non-negative number',
        };
    }

    // Warn but allow high speeds (driver might be on highway)
    if (speed > MAX_SPEED_MPS) {
        logger.warn(`High speed recorded: ${speed} m/s (${speed * 3.6} km/h)`);
    }

    return { isValid: true };
};

const validateHeading = (heading: number | undefined): { isValid: boolean; error?: string } => {
    if (heading === undefined) {
        return { isValid: true };
    }

    if (!Number.isFinite(heading) || heading < 0 || heading > 360) {
        return {
            isValid: false,
            error: 'Heading must be between 0 and 360 degrees',
        };
    }

    return { isValid: true };
};

const validateAccuracy = (accuracy: number | undefined): { isValid: boolean; warning?: string } => {
    if (accuracy === undefined) {
        return { isValid: true };
    }

    if (!Number.isFinite(accuracy) || accuracy < 0) {
        return {
            isValid: false,
            warning: 'Accuracy must be a non-negative number',
        };
    }

    if (accuracy > MAX_ACCURACY_METERS) {
        logger.warn(`Low GPS accuracy: ${accuracy}m (ideal < 10m)`);
    }

    return { isValid: true };
};

const detectSpoofing = (
    previousLocation: ValidatedLocation | null,
    currentLocation: RawLocation
): { isSuspicious: boolean; reason?: string } => {
    if (!previousLocation) {
        return { isSuspicious: false };
    }

    const currentTimestamp = new Date(currentLocation.timestamp);
    const previousTimestamp = previousLocation.validatedAt;
    const timeElapsedSeconds = (currentTimestamp.getTime() - previousTimestamp.getTime()) / 1000;

    if (timeElapsedSeconds <= 0) {
        return {
            isSuspicious: true,
            reason: 'Timestamp is not strictly increasing',
        };
    }

    const distanceMeters = calculateDistanceMeters(
        previousLocation.latitude,
        previousLocation.longitude,
        currentLocation.latitude,
        currentLocation.longitude
    );

    const impliedSpeedMps = distanceMeters / timeElapsedSeconds;

    // Allow for some margin (driver might have been on highway)
    if (impliedSpeedMps > MAX_SPEED_MPS * 1.1) {
        return {
            isSuspicious: true,
            reason: `Implied speed ${impliedSpeedMps.toFixed(2)} m/s exceeds maximum`,
        };
    }

    return { isSuspicious: false };
};

export const locationValidationService = {
    /**
     * Validate a single location update
     */
    validate(location: RawLocation): ValidationResult {
        // Validate coordinates
        const coordValidation = validateCoordinates(location.latitude, location.longitude);
        if (!coordValidation.isValid) {
            return { isValid: false, error: coordValidation.error };
        }

        // Validate timestamp
        const timestampValidation = validateTimestamp(location.timestamp);
        if (!timestampValidation.isValid) {
            return { isValid: false, error: timestampValidation.error };
        }

        // Validate speed
        const speedValidation = validateSpeed(location.speed);
        if (!speedValidation.isValid) {
            return { isValid: false, error: speedValidation.error };
        }

        // Validate heading
        const headingValidation = validateHeading(location.heading);
        if (!headingValidation.isValid) {
            return { isValid: false, error: headingValidation.error };
        }

        // Validate accuracy
        const accuracyValidation = validateAccuracy(location.accuracy);
        if (!accuracyValidation.isValid) {
            return { isValid: false, error: accuracyValidation.warning };
        }

        return { isValid: true };
    },

    /**
     * Detect if location is duplicate of previous
     */
    isDuplicate(previousLocation: ValidatedLocation | null, currentLocation: RawLocation): boolean {
        if (!previousLocation) {
            return false;
        }

        const currentTimestamp = new Date(currentLocation.timestamp);
        const previousTimestamp = previousLocation.validatedAt;
        const timeElapsedSeconds = (currentTimestamp.getTime() - previousTimestamp.getTime()) / 1000;

        // Different time = not a duplicate
        if (timeElapsedSeconds > DUPLICATE_TIME_SECONDS) {
            return false;
        }

        const distanceMeters = calculateDistanceMeters(
            previousLocation.latitude,
            previousLocation.longitude,
            currentLocation.latitude,
            currentLocation.longitude
        );

        // Same location = duplicate
        return distanceMeters <= DUPLICATE_DISTANCE_METERS;
    },

    /**
     * Detect spoofing attempts
     */
    isSuspicious(previousLocation: ValidatedLocation | null, currentLocation: RawLocation): string | null {
        const spoofCheck = detectSpoofing(previousLocation, currentLocation);
        return spoofCheck.isSuspicious ? spoofCheck.reason || 'Unknown spoofing detected' : null;
    },

    /**
     * Validate and check for duplicates/spoofing
     */
    validateBatch(
        locations: RawLocation[],
        previousLocation: ValidatedLocation | null
    ): {
        validLocations: ValidatedLocation[];
        invalidLocations: Array<{ location: RawLocation; error: string }>;
        duplicateCount: number;
        suspiciousCount: number;
    } {
        const validLocations: ValidatedLocation[] = [];
        const invalidLocations: Array<{ location: RawLocation; error: string }> = [];
        let duplicateCount = 0;
        let suspiciousCount = 0;

        // Sort by timestamp to process chronologically
        const sorted = [...locations].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        let lastValid = previousLocation;

        for (const location of sorted) {
            // Basic validation
            const validation = this.validate(location);
            if (!validation.isValid) {
                invalidLocations.push({
                    location,
                    error: validation.error || 'Unknown validation error',
                });
                continue;
            }

            // Check for duplicates
            if (lastValid && this.isDuplicate(lastValid, location)) {
                duplicateCount += 1;
                continue;
            }

            // Check for spoofing
            const suspiciousReason = this.isSuspicious(lastValid, location);
            if (suspiciousReason) {
                logger.warn(`Suspicious location detected: ${suspiciousReason}`);
                suspiciousCount += 1;
                // Still accept but mark as suspicious (administrator can review)
            }

            const validated: ValidatedLocation = {
                ...location,
                validatedAt: new Date(location.timestamp),
            };

            validLocations.push(validated);
            lastValid = validated;
        }

        return {
            validLocations,
            invalidLocations,
            duplicateCount,
            suspiciousCount,
        };
    },
};
