import Redis from 'ioredis';
import * as dotenv from 'dotenv';

dotenv.config();

const testRedis = async () => {
    const redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        db: Number(process.env.REDIS_DB) || 0,
        tls: Number(process.env.REDIS_PORT) === 6380 || process.env.REDIS_TLS === 'true'
            ? { rejectUnauthorized: false }
            : undefined,
    });

    try {
        console.log('🔄 Testing Redis connection...');

        // Test set
        await redis.set('test-key', 'hello-redis');
        console.log('✅ Set test-key');

        // Test get
        const value = await redis.get('test-key');
        console.log('✅ Get test-key:', value);

        // Test delete
        await redis.del('test-key');
        console.log('✅ Deleted test-key');

        // Verify deletion
        const deletedValue = await redis.get('test-key');
        console.log('✅ Verification after delete:', deletedValue);

        console.log('\n✨ Redis connection successful!');

    } catch (error) {
        console.error('❌ Redis error:', error instanceof Error ? error.message : error);
    } finally {
        await redis.quit();
        console.log('🔌 Redis connection closed');
    }
};

testRedis();
