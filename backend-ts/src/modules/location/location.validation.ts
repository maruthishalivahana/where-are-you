import { z } from 'zod';

export const searchLocationSchema = z.object({
    query: z.object({
        q: z
            .string()
            .trim()
            .min(3, 'Search query must be at least 3 characters')
            .max(100, 'Search query must be at most 100 characters'),
    }),
});
