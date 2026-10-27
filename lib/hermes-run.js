// Durable Hermes runs expose explicit, generation-scoped Stop control. A detached
// event stream alone does not cancel a run, so never claim cancellation on disconnect.
const http = require('http');
const crypto = require('crypto');
const { streamStage, toolStage } = require('./watch-progress');
function createRun(opts, sessionId, system, user, onApproval, onProgress) {
  let runId, events, response, settled = false, stopWanted = false, text = '';
  let resolveRun;
  const runReady = new Promise(resolve => { resolveRun = resolve; });
  let resolveResult;
  const promise = new Promise(resolve => { resolveResult = resolve; });
  const headers = { authorization: `Bearer ${opts.hermesKey}`, 'content-type': 'application/json' };
  const prefix = opts.hermesPathPrefix || '';
  const request = (method, suffix, body, extra = {}) => new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: opts.hermesPort, method, path: `${prefix}/v1/runs${suffix}`,
      headers: { ...headers, ...extra } }, res => {
      let raw = ''; res.on('data', c => { if (raw.length < 1000000) raw += c; });
      res.on('end', () => { let data; try { data = JSON.parse(raw); } catch { data = {}; } resolve({ status: res.statusCode, data }); });
      res.on('error', () => resolve({ status: 0, data: {} }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Hermes run request timed out')));
    req.on('error', () => resolve({ status: 0, data: {} }));req.end(body ? JSON.stringify(body) : undefined);
  });
  const finish = result => {
    if (settled) return;
    settled = true; resolveResult(result);
    if (response) response.destroy();
    if (events) events.destroy();
  };
  const handle = data => {
    const event = data.event || '';
    if (event === 'message.delta') { text += data.delta || ''; onProgress('Writing reply'); }
    else if (event === 'tool.started') onProgress(toolStage(data.tool, data.preview));
    else if (event === 'tool.completed') onProgress('Reviewing results');
    else if (event === 'reasoning.available') onProgress('Thinking');
    else if (event === 'run.queued') onProgress('Waiting for model');
    else if (event === 'approval.request') onApproval({ ...data, request_id: data.request_id || data.prompt_id });
    else if (event === 'run.completed') finish({ status: 200, text: typeof data.output === 'string' ? data.output : text, raw: '' });
    else if (/^run\.(cancelled|interrupted|failed)$/.test(event)) finish({ status: event === 'run.failed' ? 500 : 499, text: '', raw: String(data.error || event) });
  };
  const stream = () => {
    events = http.get({ host: '127.0.0.1', port: opts.hermesPort, path: `${prefix}/v1/runs/${encodeURIComponent(runId)}/events`,
      headers: { ...headers, accept: 'text/event-stream' } }, res => {
      response = res;
      if (res.statusCode !== 200) { res.resume(); return finish({ status: res.statusCode, text: '', raw: 'Could not observe Hermes run' }); }
      res.setEncoding('utf8');let buffer = '';
      res.on('data', chunk => {
        buffer = (buffer + chunk).replace(/\r\n/g, '\n');let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);buffer = buffer.slice(index + 2);
          const json = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          try { handle(JSON.parse(json)); } catch { /* heartbeat */ }
        }
      });
      res.on('end', () => { if (!settled && !stopWanted) finish({ status: 0, text: '', raw: 'Hermes run stream ended before its result' }); });
      res.on('error', () => { if (!settled && !stopWanted) finish({ status: 0, text: '', raw: 'Lost Hermes run stream' }); });
    });
    events.on('error', () => { if (!settled && !stopWanted) finish({ status: 0, text: '', raw: 'Could not connect to Hermes run stream' }); });
  };
  request('POST', '', { model: 'hermes-agent', input: user, instructions: system, session_id: sessionId },
    { 'Idempotency-Key': crypto.randomUUID() }).then(result => {
    runId = result.data.run_id || result.data.id;
    resolveRun(runId);
    if (result.status < 200 || result.status >= 300 || !runId) return finish({ status: result.status || 0, text: '', raw: 'Hermes did not accept the run' });
    onProgress('Starting model');
    if (!stopWanted) stream();
  });
  return { native: true, get runId() { return runId; }, promise, async stop() {
    stopWanted = true;
    const id = await runReady;
    if (!id) { stopWanted = false; return 0; }
    const result = await request('POST', `/${encodeURIComponent(id)}/stop`, {});
    if (result.status >= 200 && result.status < 300) {
      finish({ status: 499, text: '', raw: 'Stop requested' });
    } else { stopWanted = false; if (!events && !settled) stream(); }
    return result.status;
  }, cancel() { return this.stop(); } };
}
module.exports = { createRun };
