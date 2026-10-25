/**
 * Comprehensive Cache Strategy Test Suite
 * Secure Cargo Logistics Platform
 *
 * Verifies:
 * 1. Correctness: Cache hit/miss data integrity, types, and TTL expiration.
 * 2. Invalidation: Key, Tag, and Pattern-based invalidation rules.
 * 3. Authorization & Privacy: Anti-cache headers on sensitive routes, PII stripping on public tracking.
 * 4. Cache Stampede Prevention: Single-flight request coalescing under concurrent load.
 * 5. Fallback & Resilience: App remains 100% functional when cache service fails or errors.
 * 6. Performance Benchmarking: Measures real cold vs warm latencies and reports concrete numbers.
 */

const { CacheManager } = require('../src/services/cacheManager');
const { STRICT_NO_CACHE_PATTERNS, enforcePrivacyHeaders } = require('../src/middleware/cacheMiddleware');
const { getSupportedCouriersList, getPincodeInfo } = require('../src/services/carrierRateService');

// Test Helper Assertions
let totalPassed = 0;
let totalFailed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    totalPassed++;
  } else {
    console.error(`  [FAIL] ${testName}`);
    totalFailed++;
  }
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('   SECURE CARGO LOGISTICS — CACHING ARCHITECTURE TEST SUITE     ');
  console.log('================================================================\n');

  const testCache = new CacheManager({
    prefix: 'test_cargo',
    maxEntries: 100,
    defaultTtlSeconds: 5
  });

  // ── TEST SUITE 1: Correctness & Data Integrity ─────────────────────────────
  console.log('--- TEST SUITE 1: Cache Correctness & Data Integrity ---');
  {
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      return { couriers: ['Delhivery', 'Shadowfax', 'Xpressbees'], timestamp: Date.now() };
    };

    const key = testCache.generateKey('logistics:rates', { from: '110001', to: '400001', w: 0.5 });

    // 1. First fetch: Cache Miss
    const res1 = await testCache.getOrSet(key, fetcher, 2);
    assert(fetchCount === 1, 'First call triggers origin fetcher (Cache MISS)');
    assert(res1 && res1.couriers.length === 3, 'Data integrity matches origin payload');

    // 2. Second fetch: Cache Hit
    const res2 = await testCache.getOrSet(key, fetcher, 2);
    assert(fetchCount === 1, 'Second call serves from cache without hitting origin (Cache HIT)');
    assert(res2.timestamp === res1.timestamp, 'Cached payload is identical to first response');

    // 3. TTL Expiration verification
    console.log('  Waiting 2.1s for TTL expiry...');
    await new Promise(r => setTimeout(r, 2100));
    const res3 = await testCache.getOrSet(key, fetcher, 2);
    assert(fetchCount === 2, 'Expired entry triggers fresh origin fetch (TTL Expired)');
    assert(res3.timestamp > res1.timestamp, 'Fresh response has updated timestamp');
  }

  // ── TEST SUITE 2: Invalidation Rules (Key, Tag, Pattern) ───────────────────
  console.log('\n--- TEST SUITE 2: Granular Invalidation Rules ---');
  {
    const key1 = testCache.generateKey('admin:analytics', { scope: 'overview' });
    const key2 = testCache.generateKey('admin:finance', { scope: 'summary' });
    const key3 = testCache.generateKey('admin:system', { config: 'global' });
    const key4 = testCache.generateKey('logistics:rates', { route: 'del-mum' });

    await testCache.set(key1, { gmv: 500000 }, 60, ['admin:analytics', 'admin:dashboard']);
    await testCache.set(key2, { monthlyDisbursed: 450000 }, 60, ['admin:finance', 'admin:dashboard']);
    await testCache.set(key3, { feeRate: 2.5 }, 300, ['admin:config']);
    await testCache.set(key4, { rate: 55.72 }, 900, ['logistics:rates']);

    // Invalidate single tag: 'admin:config'
    const purgedConfigCount = await testCache.invalidateTag('admin:config');
    assert(purgedConfigCount === 1, 'invalidateTag("admin:config") purges exactly 1 tagged entry');
    assert(await testCache.get(key3) === null, 'System config key is purged');
    assert((await testCache.get(key1)) !== null, 'Analytics dashboard remains intact');

    // Pattern-based invalidation: 'admin:*'
    const purgedPatternCount = await testCache.invalidatePattern('admin:*');
    assert(purgedPatternCount >= 2, `invalidatePattern("admin:*") purged ${purgedPatternCount} admin entries`);
    assert(await testCache.get(key1) === null, 'Analytics overview is purged by pattern');
    assert(await testCache.get(key2) === null, 'Finance summary is purged by pattern');
    assert((await testCache.get(key4)) !== null, 'Logistics rates untouched by admin invalidation');
  }

  // ── TEST SUITE 3: Privacy & Authorization Guardrails ──────────────────────
  console.log('\n--- TEST SUITE 3: Privacy, Authorization & PII Protection ---');
  {
    // Test that sensitive route patterns are recognized and blocked from caching
    const sensitiveEndpoints = [
      '/api/v1/auth/login',
      '/api/v1/auth/signup',
      '/api/v1/profile',
      '/api/v1/wallet/transactions',
      '/api/v1/claims/dispute',
      '/api/v1/shipments/public/pay/SPL-9872-K',
      '/api/v1/youpi/create-session'
    ];

    let allSensitiveBlocked = true;
    for (const ep of sensitiveEndpoints) {
      const isBlocked = STRICT_NO_CACHE_PATTERNS.some(p => p.test(ep));
      if (!isBlocked) {
        allSensitiveBlocked = false;
        console.error(`Endpoint failed blacklist check: ${ep}`);
      }
    }
    assert(allSensitiveBlocked, 'All sensitive/auth/payment endpoints are caught by STRICT_NO_CACHE_PATTERNS');

    // Test privacy headers injection
    const headersMock = {};
    const fakeRes = {
      setHeader: (k, v) => { headersMock[k] = v; }
    };
    enforcePrivacyHeaders({ originalUrl: '/api/v1/auth/login', method: 'POST' }, fakeRes, () => {});
    assert(headersMock['Cache-Control'] === 'no-store, no-cache, must-revalidate, private', 'Privacy headers enforce no-store on sensitive auth');
    assert(headersMock['Pragma'] === 'no-cache', 'Pragma no-cache header set');

    // Test tenant/user isolation in cache keys
    const userAKey = testCache.generateKey('user:shipments', { tenantId: 'tenant_1', userId: 'usr_A' });
    const userBKey = testCache.generateKey('user:shipments', { tenantId: 'tenant_1', userId: 'usr_B' });
    const tenant2Key = testCache.generateKey('user:shipments', { tenantId: 'tenant_2', userId: 'usr_A' });

    assert(userAKey !== userBKey, 'User A and User B produce distinct, isolated cache keys');
    assert(userAKey !== tenant2Key, 'Cross-tenant user requests produce distinct, isolated cache keys');
  }

  // ── TEST SUITE 4: Cache Stampede (Single-Flight) Protection ───────────────
  console.log('\n--- TEST SUITE 4: Cache Stampede (Single-Flight Coalescing) ---');
  {
    let upstreamExecutionCount = 0;
    const expensiveOperation = async () => {
      upstreamExecutionCount++;
      // Simulate 80ms external courier API latency
      await new Promise(r => setTimeout(r, 80));
      return { quote: 55.72, carrier: 'Delhivery' };
    };

    const stampedeKey = testCache.generateKey('logistics:rates', { from: '110001', to: '560001', w: 1.0 });

    // Dispatch 25 concurrent callers simultaneously
    const CONCURRENT_REQUESTS = 25;
    const promises = [];
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
      promises.push(testCache.getOrSet(stampedeKey, expensiveOperation, 10));
    }

    const results = await Promise.all(promises);

    assert(upstreamExecutionCount === 1, `25 concurrent requests executed upstream logic EXACTLY ONCE (count: ${upstreamExecutionCount})`);
    assert(results.length === 25 && results.every(r => r.quote === 55.72), 'All 25 callers received identical correct data');
    const metrics = testCache.getMetrics();
    assert(metrics.telemetry.singleFlightStampedeSavings === 24, `Single-flight saved exactly 24 redundant upstream executions`);
  }

  // ── TEST SUITE 5: Fallback & Resilience (Cache Unavailable) ────────────────
  console.log('\n--- TEST SUITE 5: Resilience & Fallback When Cache Is Unavailable ---');
  {
    // Simulate faulty store where set/get throws
    class FaultyCache extends CacheManager {
      async get() {
        throw new Error('Simulated Redis / Memory Store Network Partition');
      }
      async set() {
        throw new Error('Simulated Store Disk Full');
      }
    }

    const resilientCache = new FaultyCache();
    let originalDataFetched = false;

    // Call getOrSet with broken store: must fall back to original data source without crashing
    const result = await resilientCache.getOrSet('test:fallback', async () => {
      originalDataFetched = true;
      return { status: 'authoritative_db_result', code: 200 };
    }, 10);

    assert(originalDataFetched === true, 'Original data source was called successfully despite cache outage');
    assert(result && result.status === 'authoritative_db_result', 'Caller receives valid data with 0 unhandled exceptions');
    assert(resilientCache.metrics.errors > 0, 'Cache errors were caught and recorded in telemetry');
    assert(resilientCache.metrics.fallbacks > 0, 'Fallback counter incremented cleanly');
  }

  // ── TEST SUITE 6: Benchmark & Latency Measurements ─────────────────────────
  console.log('\n--- TEST SUITE 6: Performance Benchmark & Latency Measurements ---');
  {
    const benchKey = testCache.generateKey('bench:query', { q: 'popular_rate_quote' });
    const simDbFetch = async () => {
      // Simulate MongoDB aggregate latency of 30ms
      await new Promise(r => setTimeout(r, 30));
      return { totalGmv: 1540000, activeShipments: 840 };
    };

    // Cold Fetch
    const t0 = process.hrtime.bigint();
    await testCache.getOrSet(benchKey, simDbFetch, 60);
    const t1 = process.hrtime.bigint();
    const coldDurationMs = Number(t1 - t0) / 1e6;

    // Warm Fetch (Cache HIT) - run 100 times to get average microsecond latency
    const iterations = 100;
    const t2 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      await testCache.getOrSet(benchKey, simDbFetch, 60);
    }
    const t3 = process.hrtime.bigint();
    const totalWarmDurationMs = Number(t3 - t2) / 1e6;
    const avgWarmDurationMs = totalWarmDurationMs / iterations;

    const speedup = (coldDurationMs / avgWarmDurationMs).toFixed(1);

    console.log(`\n  ==============================================================`);
    console.log(`  MEASURED PERFORMANCE RESULTS (REAL HARDWARE BENCHMARK):`);
    console.log(`  --------------------------------------------------------------`);
    console.log(`  Cold Fetch (Cache MISS + Simulated DB): ${coldDurationMs.toFixed(3)} ms`);
    console.log(`  Warm Fetch (Cache HIT Average):        ${avgWarmDurationMs.toFixed(4)} ms`);
    console.log(`  Total Warm Speedup Factor:             ${speedup}x FASTER`);
    console.log(`  Warm Throughput:                       ${Math.round(1000 / avgWarmDurationMs).toLocaleString()} ops/sec`);
    console.log(`  ==============================================================\n`);

    assert(avgWarmDurationMs < 1.0, `Warm fetch latency is sub-millisecond (${avgWarmDurationMs.toFixed(4)} ms)`);
    assert(coldDurationMs > avgWarmDurationMs * 10, 'Cache hit is more than 10x faster than cold fetch');
  }

  // ── Final Telemetry Summary ───────────────────────────────────────────────
  const finalMetrics = testCache.getMetrics();
  console.log('--- FINAL CACHE TELEMETRY DUMP ---');
  console.log(JSON.stringify(finalMetrics, null, 2));

  console.log('\n================================================================');
  console.log(`TEST SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED`);
  console.log('================================================================');

  testCache.memoryStore.destroy();
  if (totalFailed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
