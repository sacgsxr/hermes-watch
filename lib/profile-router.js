const http = require('http');

// Each profile owns a complete relay instance: sessions, replies, jobs and speech.
function createProfileServer(createServer, profiles) {
  const servers = Object.fromEntries(Object.entries(profiles).map(([name, opts]) => [name, createServer(opts)]));
  if (!servers.default) throw new Error('default watch profile required');
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://watch');
    let profile = 'default';
    if (url.pathname.startsWith('/p/')) {
      const match = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/);
      if (!match || !Object.hasOwn(servers, match[1])) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Unknown watch profile' }));
      }
      profile = match[1];
      req.url = match[2] + url.search;
    }
    servers[profile].emit('request', req, res);
  });
}
module.exports = { createProfileServer };
