const http = require('http');
const fs = require('fs');

const PORT = 9090;
const configFile = process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : 'config.json';
const cfgPath = `/app/cfg/${configFile}`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/config') && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = Object.fromEntries(url.searchParams);
    if (Object.keys(query).length) {
      const old = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
      fs.writeFileSync(cfgPath, JSON.stringify({ ...old, ...query }, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...old, ...query }));
    } else {
      const old = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(old));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
}); 