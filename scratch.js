const fs = require('fs');
const content = fs.readFileSync('c:/Users/sohil/NebulaStreams/index.js', 'utf8');
const lines = content.split('\n');
const before = lines.slice(0, 165);
const after = lines.slice(2700);
fs.writeFileSync('c:/Users/sohil/NebulaStreams/index.js', before.join('\n') + '\n// REPLACEME\n' + after.join('\n'));
