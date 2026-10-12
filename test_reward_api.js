const http = require('http');

const options = {
  hostname: 'localhost',
  port: 5001,
  path: '/api/v1/rewards/wallet',
  method: 'GET',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    console.log(`HTTP Status: ${res.statusCode}`);
    console.log(`Response Body: ${data}`);
  });
});

req.on('error', (err) => {
  console.error('API Test Error:', err.message);
});

req.end();
