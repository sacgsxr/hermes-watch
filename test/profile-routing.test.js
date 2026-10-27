const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../relay');
const { createProfileServer } = require('../lib/profile-router');
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('Default and Health isolate API credentials, sessions, retry IDs, last replies and speech', async t => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const profile = req.url.startsWith('/p/health/') ? 'health' : 'default';
    if (req.headers.authorization !== `Bearer ${profile}-key`) { res.writeHead(401); return res.end(); }
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      const body = JSON.parse(data);
      received.push({ profile, url: req.url, session: req.headers['x-hermes-session-id'] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: body.messages[1].content.split('\n')[0] === 'draft email' ? 'Draft ready.\nCONFIRM: Send this email?' : profile + ':' + body.messages[1].content.split('\n')[0] } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  const port = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-profiles-'));
  const common = { token: 'watch-token', hermesPort: port, sttUrl: 'http://127.0.0.1:1/stt', actionsEnabled: false,
    systemPrompt: () => '', turnRules: x => x, tts: async x => Buffer.from(x) };
  const server = createProfileServer(createServer, {
    default: { ...common, hermesKey: 'default-key', sessionFile: path.join(dir, 'default.json') },
    health: { ...common, hermesKey: 'health-key', hermesPathPrefix: '/p/health', sessionFile: path.join(dir, 'health.json') },
  });
  const relayPort = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  const call = async (route, body, auth = true) => {
    const r = await fetch(`http://127.0.0.1:${relayPort}${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer watch-token' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  assert.equal((await call('/p/health/watch/last', null, false)).status, 401);
  assert.equal((await call('/p/unknown/watch/ask', { text: 'private' })).status, 404);
  assert.equal((await call('/p/health/watch/stop', { job: 'unknown' }, false)).status, 401);
  const d = await call('/watch/ask', { text: 'everyday', rid: 'same-rid', speak: true });
  const h = await call('/p/health/watch/ask', { text: 'private-health', rid: 'same-rid', speak: true });
  assert.equal(d.body.text, 'default:everyday');
  assert.equal(h.body.text, 'health:private-health');
  assert.equal(received.length, 2);
  assert.equal(received[1].url, '/p/health/v1/chat/completions');
  assert.notEqual(received[0].session, received[1].session);
  assert.equal((await call('/p/default/watch/last')).body.text, 'default:everyday');
  assert.equal((await call('/p/health/watch/last')).body.text, 'health:private-health');
  await call('/p/health/watch/ask', { text: 'private-health', rid: 'same-rid' });
  assert.equal(received.length, 2);
  assert.equal((await call(`/p/default/watch/speech?id=${h.body.speech}`)).status, 404);
  assert.equal((await call(`/p/health/watch/speech?id=${d.body.speech}`)).status, 404);
  const card = await call('/p/health/watch/ask', { text: 'draft email', rid: 'draft' });
  assert.equal(card.body.kind, 'confirm');
  const wrong = await call('/p/default/watch/confirm', { id: card.body.id, yes: true, rid: 'wrong-profile' });
  assert.match(wrong.body.text, /expired/);
  const right = await call('/p/health/watch/confirm', { id: card.body.id, yes: true, rid: 'right-profile' });
  assert.equal(right.body.text, 'health:yes, go ahead');
  const beforeReset = (await call('/p/default/watch/last')).body.text;
  await call('/p/health/watch/ask', { text: 'start new session', rid: 'health-reset' });
  assert.equal((await call('/p/default/watch/last')).body.text, beforeReset);
});


test('Stop is confined to the same profile even when request IDs match', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url.endsWith('/stop')) { res.writeHead(200); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"test-run","choices":[{"delta":{"role":"assistant"}}]}\n\n');
    const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 5000);
    res.on('close', () => clearTimeout(timer));
  });
  const port = await listen(upstream);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-stop-profiles-'));
  const common = { token: 'watch-token', hermesKey: 'key', hermesPort: port, sttUrl: 'http://127.0.0.1:1/stt', deadlineMs: 20 };
  const server = createProfileServer(createServer, {
    default: { ...common, sessionFile: path.join(dir, 'default.json') },
    health: { ...common, hermesPathPrefix: '/p/health', sessionFile: path.join(dir, 'health.json') },
  });
  const relayPort = await listen(server);
  t.after(() => { server.close(); server.closeAllConnections(); upstream.close(); upstream.closeAllConnections(); });
  const post = async (profile, endpoint, body) => (await fetch(`http://127.0.0.1:${relayPort}/p/${profile}/watch/${endpoint}`, {
    method: 'POST', headers: { Authorization: 'Bearer watch-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const h = await post('health', 'ask', { text: 'hold Health', rid: 'same' });
  const d = await post('default', 'ask', { text: 'hold Default', rid: 'same' });
  assert.equal((await post('default', 'stop', { job: h.job })).ok, false);
  await post('health', 'stop', { job: h.job });
  assert.equal((await post('default', 'result', { job: d.job })).kind, 'working');
  await post('default', 'stop', { job: d.job });
});
