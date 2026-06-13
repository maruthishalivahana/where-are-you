import NodeCache from 'node-cache';
import { NominatimProvider, LocationProvider } from './location.provider';
import { logger } from '../../utils/logger';
import { LocationSearchResult } from './location.types';

const CACHE_TTL_SECONDS = 600;
const CACHE_CHECK_PERIOD_SECONDS = 120;

const normalizeSearchQuery = (query: string): string => query.trim().replace(/\s+/g, ' ');

export class LocationService {
    private readonly provider: LocationProvider;
    private readonly cache: NodeCache;

    constructor(provider: LocationProvider = new NominatimProvider()) {
        this.provider = provider;
        this.cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS, checkperiod: CACHE_CHECK_PERIOD_SECONDS });
    }

    async searchLocations(query: string): Promise<LocationSearchResult[]> {
        const sanitizedQuery = normalizeSearchQuery(query);
        if (!sanitizedQuery) {
            throw new Error('Search query cannot be empty');
        }

        const cacheKey = `location-search:${sanitizedQuery.toLowerCase()}`;
        const cached = this.cache.get<LocationSearchResult[]>(cacheKey);
        if (cached) {
            logger.info('Location search cache hit', {
                query: sanitizedQuery,
                resultsCount: cached.length,
            });
            return cached;
        }

        const results = await this.provider.searchLocations(sanitizedQuery);
        this.cache.set(cacheKey, results);

        logger.info('Location search cache set', {
            query: sanitizedQuery,
            resultsCount: results.length,
            ttlSeconds: CACHE_TTL_SECONDS,
        });

        return results;
    }

    clearCache(): void {
        this.cache.flushAll();
    }
}

export const locationService = new LocationService();
