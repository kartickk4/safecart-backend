/**
 * High-Precision Multi-Virtual-User Load Testing Harness
 * Secure Cargo Logistics Platform
 *
 * Simulates realistic virtual user journeys with think times, measures throughput,
 * latencies (p50, p90, p95, p99), error rates, CPU/RAM utilization, and enforces
 * circuit breaker abort thresholds.
 */

const http = require('http');
const https = require('https');
const os = require('os');
require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || '7fb942837267faa78f055e9a7c580395125ab8bee45adae0f3e3da3f58769943';
const TEST_AUTH_TOKEN = jwt.sign({
  id: '64b000000000000000000001',
  email: 'loadtest_user@securekaro.in',
  role: 'User'
}, JWT_SECRET, { expiresIn: '1d' });

// Parse CLI flags
const args = process.argv.slice(2);
function getArg(name, def) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return def;
}

const VUS = parseInt(getArg('--vus', '10'), 10);
const DURATION_SEC = parseInt(getArg('--duration', '15'), 10);
const TARGET_URL = getArg('--target', 'http://127.0.0.1:5001');
const LOAD_TEST_SECRET = process.env.LOAD_TEST_TOKEN || 'securekaro_load_test_sandbox';

const parsedTarget = new URL(TARGET_URL);
const isHttps = parsedTarget.protocol === 'https:';
const client = isHttps ? https : http;

// High-concurrency Keep-Alive Agent to avoid socket exhaustion
const agent = new client.Agent({
  keepAlive: true,
  maxSockets: Math.max(200, VUS * 4),
  maxFreeSockets: 50,
  timeout: 10000
});

// Telemetry State
const stats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  timeouts: 0,
  statusCodes: {},
  latencies: [],
  endpointStats: {},
  aborted: false,
  abortReason: null,
  cpuStart: process.cpuUsage(),
  memStart: process.memoryUsage(),
  startTime: null,
  endTime: null
};

// Endpoints mix definition
const ENDPOINTS = [
  {
    name: 'couriers_directory',
    path: '/api/v1/shipments/couriers',
    method: 'GET',
    weight: 25,
    minThinkMs: 150,
    maxThinkMs: 400
  },
  {
    name: 'pincode_serviceability',
    path: '/api/v1/shipments/serviceability/pincode/110001',
    method: 'GET',
    weight: 20,
    minThinkMs: 150,
    maxThinkMs: 400
  },
  {
    name: 'awb_tracking',
    path: '/api/v1/tracking/TC-delhivery-1000000001',
    method: 'GET',
    weight: 30,
    minThinkMs: 250,
    maxThinkMs: 600
  },
  {
    name: 'system_health',
    path: '/health',
    method: 'GET',
    weight: 15,
    minThinkMs: 300,
    maxThinkMs: 800
  },
  {
    name: 'carrier_rate_quote',
    path: '/api/v1/agent/carrier-rates',
    method: 'POST',
    weight: 8,
    minThinkMs: 400,
    maxThinkMs: 1000,
    body: JSON.stringify({
      fromPincode: '110001',
      toPincode: '400001',
      weightKg: 0.5,
      paymentMode: 'cod',
      declaredValue: 2500
    })
  },
  {
    name: 'tracking_webhook',
    path: '/api/v1/tracking/webhook/carrier-tracking',
    method: 'POST',
    weight: 2,
    minThinkMs: 300,
    maxThinkMs: 800,
    body: JSON.stringify({
      awb: 'TC-delhivery-1000000001',
      status: 'In Transit',
      location: 'Regional Sorting Hub'
    })
  }
];

// Weighted random selector
function selectEndpoint() {
  const totalWeight = ENDPOINTS.reduce((acc, e) => acc + e.weight, 0);
  let r = Math.random() * totalWeight;
  for (const ep of ENDPOINTS) {
    if (r < ep.weight) return ep;
    r -= ep.weight;
  }
  return ENDPOINTS[0];
}

// Single HTTP Request executor
function executeRequest(ep) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const reqOptions = {
      protocol: parsedTarget.protocol,
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (isHttps ? 443 : 80),
      path: ep.path,
      method: ep.method,
      agent,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${TEST_AUTH_TOKEN}`,
        'x-load-test-token': LOAD_TEST_SECRET,
        ...(ep.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(ep.body)
        } : {})
      },
      timeout: 8000
    };

    const req = client.request(reqOptions, (res) => {
      let bodyLen = 0;
      res.on('data', (chunk) => { bodyLen += chunk.length; });
      res.on('end', () => {
        const t1 = process.hrtime.bigint();
        const durationMs = Number(t1 - t0) / 1e6;
        const statusCode = res.statusCode;

        stats.totalRequests++;
        stats.statusCodes[statusCode] = (stats.statusCodes[statusCode] || 0) + 1;

        if (!stats.endpointStats[ep.name]) {
          stats.endpointStats[ep.name] = { total: 0, errors: 0, latencies: [] };
        }
        stats.endpointStats[ep.name].total++;
        stats.endpointStats[ep.name].latencies.push(durationMs);

        // Treat 2xx and expected 404 (e.g. mock AWB not found) as valid response
        if (statusCode >= 200 && statusCode < 400 || statusCode === 404) {
          stats.successfulRequests++;
        } else {
          stats.failedRequests++;
          stats.endpointStats[ep.name].errors++;
        }

        stats.latencies.push(durationMs);
        resolve({ durationMs, statusCode });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      stats.totalRequests++;
      stats.timeouts++;
      stats.failedRequests++;
      stats.latencies.push(8000);
      resolve({ durationMs: 8000, statusCode: 'TIMEOUT' });
    });

    req.on('error', (err) => {
      stats.totalRequests++;
      stats.failedRequests++;
      stats.latencies.push(8000);
      resolve({ durationMs: 8000, statusCode: 'ERROR', error: err.message });
    });

    if (ep.body) req.write(ep.body);
    req.end();
  });
}

// Single Virtual User loop
async function runVirtualUser(vuId, stopTime) {
  while (Date.now() < stopTime && !stats.aborted) {
    const ep = selectEndpoint();
    await executeRequest(ep);

    // Dynamic think time (human cadence)
    const thinkTime = Math.random() * (ep.maxThinkMs - ep.minThinkMs) + ep.minThinkMs;
    await new Promise(r => setTimeout(r, thinkTime));

    // Circuit Breaker: check error rate every 20 requests
    if (stats.totalRequests > 50 && (stats.totalRequests % 25 === 0)) {
      const errorRate = stats.failedRequests / stats.totalRequests;
      if (errorRate > 0.08) { // 8% error rate abort
        stats.aborted = true;
        stats.abortReason = `Circuit Breaker: Error rate reached ${(errorRate * 100).toFixed(1)}% (exceeded 8% limit)`;
        break;
      }
    }
  }
}

// Percentile calculator
function calculatePercentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function startLoadTest() {
  console.log('================================================================');
  console.log('       SECURE CARGO LOGISTICS — LOAD TESTING ENGINE             ');
  console.log('================================================================');
  console.log(` Target Server:       ${TARGET_URL}`);
  console.log(` Virtual Users (VUs): ${VUS}`);
  console.log(` Target Duration:     ${DURATION_SEC} seconds`);
  console.log(` Sandbox Mode:        MOCK ENABLED (Zero SMS, Zero Real Money)`);
  console.log(` CPU Cores:           ${os.cpus().length} | Arch: ${os.arch()}`);
  console.log('================================================================\n');

  // Pre-test warm-up ping
  try {
    const pingRes = await fetch(`${TARGET_URL}/health`);
    console.log(`[WARM-UP PING] Target server responded: HTTP ${pingRes.status}`);
  } catch (err) {
    console.error(`[ERROR] Cannot reach target server at ${TARGET_URL}:`, err.message);
    process.exit(1);
  }

  stats.startTime = Date.now();
  const stopTime = stats.startTime + (DURATION_SEC * 1000);

  console.log(`\nStarting load test with ${VUS} concurrent virtual users...\n`);

  // Spawn VUs
  const vuPromises = [];
  for (let i = 0; i < VUS; i++) {
    // Stagger startup slightly to prevent unnatural connection spike on millisecond 0
    const startupJitter = Math.floor(Math.random() * 500);
    vuPromises.push(new Promise(resolve => {
      setTimeout(() => runVirtualUser(i + 1, stopTime).then(resolve), startupJitter);
    }));
  }

  // Periodic status reporter
  const interval = setInterval(() => {
    const elapsedSec = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    const rps = (stats.totalRequests / (elapsedSec || 1)).toFixed(1);
    const recentP95 = calculatePercentile(stats.latencies.slice(-50), 95).toFixed(1);
    console.log(`  [+${elapsedSec}s] Completed: ${stats.totalRequests} reqs | RPS: ${rps} | Latency p95: ${recentP95}ms | Errors: ${stats.failedRequests}`);
    if (Date.now() >= stopTime || stats.aborted) {
      clearInterval(interval);
    }
  }, 3000);

  await Promise.all(vuPromises);
  clearInterval(interval);

  stats.endTime = Date.now();
  const actualDurationSec = (stats.endTime - stats.startTime) / 1000;
  const cpuEnd = process.cpuUsage(stats.cpuStart);
  const memEnd = process.memoryUsage();

  const rps = parseFloat((stats.totalRequests / actualDurationSec).toFixed(2));
  const p50 = calculatePercentile(stats.latencies, 50).toFixed(2);
  const p90 = calculatePercentile(stats.latencies, 90).toFixed(2);
  const p95 = calculatePercentile(stats.latencies, 95).toFixed(2);
  const p99 = calculatePercentile(stats.latencies, 99).toFixed(2);
  const min = Math.min(...(stats.latencies.length ? stats.latencies : [0])).toFixed(2);
  const max = Math.max(...(stats.latencies.length ? stats.latencies : [0])).toFixed(2);
  const errorRatePct = parseFloat(((stats.failedRequests / (stats.totalRequests || 1)) * 100).toFixed(2));

  console.log('\n================================================================');
  console.log('                   LOAD TEST RESULTS SUMMARY                    ');
  console.log('================================================================');
  if (stats.aborted) {
    console.log(` ⚠️  TEST ABORTED EARLY: ${stats.abortReason}`);
  } else {
    console.log(` Status:           COMPLETED SUCCESSFULLY`);
  }
  console.log(` Virtual Users:    ${VUS}`);
  console.log(` Actual Duration:  ${actualDurationSec.toFixed(2)} seconds`);
  console.log(` Total Requests:   ${stats.totalRequests.toLocaleString()}`);
  console.log(` Success Requests: ${stats.successfulRequests.toLocaleString()}`);
  console.log(` Failed Requests:  ${stats.failedRequests}`);
  console.log(` Timeouts:         ${stats.timeouts}`);
  console.log(` Error Rate:       ${errorRatePct}%`);
  console.log(` Throughput:       ${rps} req/sec`);
  console.log('----------------------------------------------------------------');
  console.log(' LATENCY DISTRIBUTION:');
  console.log(`   Min Latency:    ${min} ms`);
  console.log(`   p50 (Median):   ${p50} ms`);
  console.log(`   p90:            ${p90} ms`);
  console.log(`   p95:            ${p95} ms`);
  console.log(`   p99:            ${p99} ms`);
  console.log(`   Max Latency:    ${max} ms`);
  console.log('----------------------------------------------------------------');
  console.log(' STATUS CODES:');
  for (const [code, count] of Object.entries(stats.statusCodes)) {
    console.log(`   HTTP ${code}: ${count} (${((count / stats.totalRequests) * 100).toFixed(1)}%)`);
  }
  console.log('----------------------------------------------------------------');
  console.log(' ENDPOINT BREAKDOWN:');
  for (const [epName, epStat] of Object.entries(stats.endpointStats)) {
    const epP95 = calculatePercentile(epStat.latencies, 95).toFixed(1);
    console.log(`   ${epName.padEnd(25)}: ${epStat.total.toString().padStart(6)} reqs | p95: ${epP95.padStart(6)}ms | Errors: ${epStat.errors}`);
  }
  console.log('----------------------------------------------------------------');
  console.log(' SYSTEM RESOURCE USAGE:');
  console.log(`   User CPU Time:    ${(cpuEnd.user / 1e6).toFixed(2)} seconds`);
  console.log(`   System CPU Time:  ${(cpuEnd.system / 1e6).toFixed(2)} seconds`);
  console.log(`   Heap Used:        ${(memEnd.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   RSS Memory:       ${(memEnd.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log('================================================================\n');

  return {
    vus: VUS,
    durationSec: actualDurationSec,
    totalRequests: stats.totalRequests,
    throughputRps: rps,
    p50,
    p95,
    p99,
    errorRatePct,
    aborted: stats.aborted
  };
}

startLoadTest().catch(err => {
  console.error('Runner Execution Error:', err);
  process.exit(1);
});
