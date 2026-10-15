// Child-only fixture: redirect the default tiers read, leaving every other file untouched.
// Keep the real loader, CLI and installer so their integration behavior is still exercised.
const fs = require('node:fs');
const { resolve, join } = require('node:path');
const target = resolve(__dirname, '../../tiers.json');
const fixture = join(__dirname, 'tiers.json');
const read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  return read.call(
    this,
    typeof path === 'string' && resolve(path) === target ? fixture : path,
    ...args
  );
};
