const path = require('path');
const fs = require('fs');

function loadModule(baseDir, type, name) {
  const candidates = [
    path.resolve(baseDir, '..', type, name),
    path.resolve(baseDir, type, name),
    path.resolve(baseDir, name),
    path.resolve(process.cwd(), 'src', type, name),
    path.resolve(process.cwd(), type, name),
    path.resolve(process.cwd(), name)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c + '.js')) return require(c + '.js');
    if (fs.existsSync(c)) return require(c);
  }
  try { return require(`../${type}/${name}`); } catch(e) {}
  try { return require(`./${name}`); } catch(e) {}
  return require(`../${name}`);
}

module.exports = loadModule;
