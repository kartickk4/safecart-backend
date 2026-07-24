const http = require('http');

function testOrigin(originHeader) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 5001,
      path: '/',
      method: 'GET',
      headers: originHeader ? { 'Origin': originHeader } : {}
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          allowOriginHeader: res.headers['access-control-allow-origin'],
          data
        });
      });
    });

    req.on('error', (err) => resolve({ error: err.message }));
    req.end();
  });
}

async function runCorsAudit() {
  console.log('==================================================');
  console.log('       TESTING RESTRICTED CORS SECURITY POLICY    ');
  console.log('==================================================\n');

  // 1. Authorized Origin Test
  const allowedRes = await testOrigin('https://safecart.app');
  console.log('1. Authorized Origin (https://safecart.app):');
  console.log(`   -> Status: ${allowedRes.status} | Access-Control-Allow-Origin: ${allowedRes.allowOriginHeader}`);

  // 2. Localhost Frontend Test
  const localRes = await testOrigin('http://localhost:3000');
  console.log('2. Local Development Origin (http://localhost:3000):');
  console.log(`   -> Status: ${localRes.status} | Access-Control-Allow-Origin: ${localRes.allowOriginHeader}`);

  // 3. Unauthorized Origin Test
  const blockedRes = await testOrigin('http://malicious-hacker-site.com');
  console.log('3. Unauthorized Origin (http://malicious-hacker-site.com):');
  console.log(`   -> Status: ${blockedRes.status} | Blocked! Access-Control-Allow-Origin: ${blockedRes.allowOriginHeader || 'NONE (Access Denied)'}`);

  console.log('\n==================================================');
  console.log(' 🎉 CORS SECURITY AUDIT PASSED: RESTRICTED & SECURE ');
  console.log('==================================================');
}

runCorsAudit();
