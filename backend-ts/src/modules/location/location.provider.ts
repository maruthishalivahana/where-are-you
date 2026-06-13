import axios, { AxiosInstance } from 'axios';
import { LocationSearchResult } from './location.types';
import { logger } from '../../utils/logger';

export interface LocationProvider {
    searchLocations(query: string): Promise<LocationSearchResult[]>;
}

export class LocationProviderError extends Error {
    public statusCode: number;

    constructor(message: string, statusCode = 500) {
        super(message);
        this.name = 'LocationProviderError';
        this.statusCode = statusCode;
    }
}

type NominatimResult = {
    display_name: string;
    lat: string;
    lon: string;
};

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

export class NominatimProvider implements LocationProvider {
    private readonly httpClient: AxiosInstance;

    constructor(requestTimeoutMs = 5000) {
        this.httpClient = axios.create({
            timeout: requestTimeoutMs,
            headers: {
                'User-Agent': 'NavixGo/1.0 (admin search)',
                Accept: 'application/json',
            },
        });
    }

    async searchLocations(query: string): Promise<LocationSearchResult[]> {
        const trimmedQuery = query.trim();
        if (!trimmedQuery) {
            return [];
        }

        try {
            const response = await this.httpClient.get<NominatimResult[]>(NOMINATIM_SEARCH_URL, {
                params: {
                    q: trimmedQuery,
                    format: 'json',
                    limit: 10,
                },
            });

            return response.data.map((result) => ({
                displayName: result.display_name,
                latitude: Number(result.lat),
                longitude: Number(result.lon),
                address: result.display_name,
            }));
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNABORTED') {
                    throw new LocationProviderError('Location provider timed out', 504);
                }

                const warningMessage = error.response
                    ? 'Location provider returned an unexpected response'
                    : 'Unable to reach location provider';

                logger.warn('NominatimProvider request failed', {
                    query: trimmedQuery,
                    status: error.response?.status,
                    data: error.response?.data,
                });

                throw new LocationProviderError(warningMessage, 502);
            }

            logger.error('Unexpected error in NominatimProvider', error);
            throw new LocationProviderError('Unexpected error while searching locations', 500);
        }
    }
}
