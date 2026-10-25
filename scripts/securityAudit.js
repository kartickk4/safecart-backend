const http = require('http');

const BASE_URL = 'http://localhost:5001';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

const makeRequest = (method, path, headers = {}, body = null) => {
  return new Promise((resolve) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed
        });
      });
    });

    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });

    if (body) {
      req.write(typeof body === 'object' ? JSON.stringify(body) : body);
    }
    req.end();
  });
};

const runAudit = async () => {
  console.log(`${colors.cyan}${colors.bold}======================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  🛡️  SECUREKARO AUTOMATED PENETRATION & SECURITY AUDIT  ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}======================================================${colors.reset}\n`);

  let passed = 0;
  let failed = 0;

  const test = (name, isPass, detail) => {
    if (isPass) {
      console.log(`  ${colors.green}✔ PASS${colors.reset} - ${colors.bold}${name}${colors.reset}`);
      passed++;
    } else {
      console.log(`  ${colors.red}✖ FAIL${colors.reset} - ${colors.bold}${name}${colors.reset} (${colors.yellow}${detail}${colors.reset})`);
      failed++;
    }
  };

  // 1. Healthcheck
  const health = await makeRequest('GET', '/health');
  if (health.error) {
    console.log(`${colors.red}CRITICAL: Local server not responding on ${BASE_URL}. Ensure server is running.${colors.reset}`);
    process.exit(1);
  }
  test('Server Status & Healthcheck Online', health.status === 200, `Status: ${health.status}`);

  // 2. Security Headers (Helmet)
  test('HSTS Header Enforced', Boolean(health.headers['strict-transport-security']), 'Missing Strict-Transport-Security');
  test('X-Content-Type-Options: nosniff', health.headers['x-content-type-options'] === 'nosniff', 'Missing nosniff header');
  test('X-Frame-Options: DENY (Clickjacking Guard)', health.headers['x-frame-options'] === 'DENY', 'Missing frameguard');
  test('X-Powered-By Header Stripped', !health.headers['x-powered-by'], 'x-powered-by header is leaking server info');

  // 3. Unauthenticated Access to Protected Endpoints (Auth Guard)
  const unauthShipments = await makeRequest('GET', '/api/v1/shipments');
  test('Auth Guard on /api/v1/shipments (Requires Token)', unauthShipments.status === 401, `Status was ${unauthShipments.status}`);

  const unauthWallet = await makeRequest('GET', '/api/v1/wallet/balance');
  test('Auth Guard on /api/v1/wallet/balance (Requires Token)', unauthWallet.status === 401, `Status was ${unauthWallet.status}`);

  const unauthClaims = await makeRequest('GET', '/api/v1/claims/my-count');
  test('Auth Guard on /api/v1/claims/my-count (Requires Token)', unauthClaims.status === 401, `Status was ${unauthClaims.status}`);

  const unauthPhotoReview = await makeRequest('POST', '/api/v1/shipments/SK-HACK-ID/photo-review-pay');
  test('Auth Guard on /photo-review-pay (Previously Exposed Route)', unauthPhotoReview.status === 401, `Status was ${unauthPhotoReview.status}`);

  // 4. Admin Boundary Isolation
  const unauthAdminUsers = await makeRequest('GET', '/api/v1/admin/users');
  test('Admin Boundary on /api/v1/admin/users (Requires Admin Role)', unauthAdminUsers.status === 401 || unauthAdminUsers.status === 403, `Status was ${unauthAdminUsers.status}`);

  const unauthAdminShipments = await makeRequest('GET', '/api/v1/admin/shipments');
  test('Admin Boundary on /api/v1/admin/shipments (Requires Admin Role)', unauthAdminShipments.status === 401 || unauthAdminShipments.status === 403, `Status was ${unauthAdminShipments.status}`);

  // 5. NoSQL Injection Test on Login & OTP
  const nosqlAttack = await makeRequest('POST', '/api/v1/auth/login', {}, {
    email: { "$gt": "" },
    password: { "$gt": "" }
  });
  test('NoSQL Injection Guard on Login (Sanitization Active)', nosqlAttack.status === 400 || nosqlAttack.status === 422, `Status was ${nosqlAttack.status}`);

  // 6. Strict Zod Schema Validation on Email OTP
  const invalidEmailOtp = await makeRequest('POST', '/api/v1/auth/send-email-otp', {}, {
    email: "not-an-email-address"
  });
  test('Zod Schema Validation on /send-email-otp', invalidEmailOtp.status === 400 || invalidEmailOtp.status === 422, `Status was ${invalidEmailOtp.status}`);

  // 7. CORS Origin Isolation
  const maliciousCors = await makeRequest('GET', '/api/v1/couriers', {
    'Origin': 'https://malicious-attacker-website.com'
  });
  test('CORS Policy Blocks Untrusted Origins', maliciousCors.status === 500 || !maliciousCors.headers['access-control-allow-origin'] || maliciousCors.headers['access-control-allow-origin'] !== 'https://malicious-attacker-website.com', 'CORS accepted malicious origin');

  console.log(`\n${colors.cyan}${colors.bold}======================================================${colors.reset}`);
  console.log(`  ${colors.bold}SUMMARY:${colors.reset} ${colors.green}${passed} PASSED${colors.reset} | ${failed > 0 ? colors.red : colors.green}${failed} FAILED${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}======================================================${colors.reset}\n`);

  if (failed === 0) {
    console.log(`${colors.green}${colors.bold}🛡️ ALL CRITICAL SECURITY ATTACK VECTORS BLOCKED AND HARDENED!${colors.reset}\n`);
  }
};

runAudit();
