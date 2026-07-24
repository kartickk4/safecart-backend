const path = require('path');
const fs = require('fs');

const srcServerPath = path.join(__dirname, 'src', 'server.js');
if (fs.existsSync(srcServerPath)) {
  require(srcServerPath);
} else {
  require('./server.js');
}
