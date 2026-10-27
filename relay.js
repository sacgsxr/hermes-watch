// Relay between the Hermes app on an Amazfit watch and Hermes Agent's API server.
//
// watch -> Side Service in the Zepp iPhone app -> tailnet https :8453 -> this relay
//   (127.0.0.1:8796 by default, WATCH_PORT; loopback only)
//   -> stt/stt_worker.py (8797) to turn the recording into text
//   -> Hermes API server (WATCH_HERMES_PORT, 8642 by default) in its own "watch-..." session.
//
// Production defaults are read-only: direct actions (texts, car, PC restart) and Telegram
// notifications stay off unless WATCH_ACTIONS / WATCH_NOTIFY are set to 1.
//
// - Texts and car commands ("text X saying Y", "unlock the car", ...) are recognised here in
//   plain code (lib/actions.js) and only run after a Yes tap: the watch gets a
//   confirm card with a one-time id (60 s), and POST /watch/confirm runs it through the local
//   text / Tesla MCP servers. Hermes is told never to call those tools; if it proposes an
//   action anyway (email drafts), its reply ends in "CONFIRM: ...", which also becomes a card
//   whose answer goes back to Hermes as the next turn.
// - Answers within WATCH_DEADLINE_MS (12 s; the Zepp app on the iPhone lost replies that took
//   20 s or more) come back directly; slower ones become a job the watch polls with GET /watch/result.
//
// Exposed tailnet-only: tailscale serve --bg --https=8453 http://127.0.0.1:8796
const http = require('http');
const { streamStage } = require('./lib/watch-progress');
const { createRun } = require('./lib/hermes-run');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { timeString, isResetCommand, formatForHud, truncateForHud, parsePcRestartCommand, cancelPcRestart,
  isPcHealthRequest, gatherPcHealthAsync } = require('./lib/voice-common');
const { formatPcHealth } = require('./lib/pc-health');
const actions = require('./lib/actions');
const { watchSystemPrompt, withWatchRules, splitConfirm, WATCH_CHAR_BUDGET } = require('./lib/watch-prompt');

// The safe slice: the relay asks the already-running Hermes profile and shows its answers;
// it never sends texts or touches the car or PC itself (relay-only shortcuts like "new session"
// and the read-only PC health check stay). createServer keeps the full behaviour for tests.
const AGENT_ACTION_RULE = 'Use the selected Hermes profile and its available tools to carry out the user\'s explicit requests, including sending email when asked. Honor the profile\'s normal approval requirements. Do not claim an action succeeded until its tool result confirms success.';
const NO_ACTION_RULE = 'This watch build has no direct actions: do not propose sending texts, emails or car commands.';
function promptWithRules(text, rules) {
  if (!rules || !rules.length) return text;
  return `${text}\n\n(Rule for this answer: ${rules.join(' ')})`;
}
// Minimal system prompt for the safe slice: no email-reading rule, no Claude Code tooling
// rule, no CONFIRM action proposals - just the stable watch format.
function safeSystemPrompt() {
  return 'You are answering through Hermes on an Amazfit watch. '
    + 'The message is raw speech-to-text: expect misheard words, run-on phrasing and missing punctuation; read it charitably. '
    + `Plain text only - no markdown, links or images. Under ${WATCH_CHAR_BUDGET} characters. ${NO_ACTION_RULE}`;
}

const IDLE_MS = 6 * 60 * 60 * 1000;
const JOB_CAP_MS = 30 * 60 * 1000; // Claude Code builds can take 15 min
const BUILD_NOTE = 'Approved - working on it. You can close the app; the result also comes to Telegram.';
const JOB_KEEP_MS = 30 * 60 * 1000;
const PC_HEALTH_TIMEOUT_MS = 12000;
const MISHEARD_HEALTH = /\b(pc|computer)\W+help check\b/i; // Whisper heard "PC, help check."
const DEFAULT_DEADLINE_MS = 12000; // the iPhone Zepp app lost replies that took 20 s or more
const MAX_BODY = 3_000_000;

function newSessionId(now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `watch-${d}-${crypto.randomBytes(3).toString('hex')}`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function createServer(opts) {
  const log = opts.log || (() => {});
  const runAction = opts.runAction || actions.runAction;
  const pcHealth = opts.pcHealth || (() => gatherPcHealthAsync(PC_HEALTH_TIMEOUT_MS));
  const cancelRestart = opts.cancelRestart || cancelPcRestart;
  const deadlineMs = opts.deadlineMs || DEFAULT_DEADLINE_MS;
  const recordTurn = opts.recordTurn || (() => {});
  const tts = opts.tts || ((text) => postTts(new URL('/tts', opts.sttUrl), text));
  const notify = opts.notify || (() => {});
  const actionsEnabled = !!opts.actionsEnabled;
  const agentActionsEnabled = !!opts.agentActionsEnabled;
  const notifyEnabled = !!opts.notifyEnabled;
  // Prompt rules for this build: the full watch rules when actions are enabled (the default,
  // as in tests), or just "no direct actions" for the safe slice.
  const systemPrompt = opts.systemPrompt !== undefined ? opts.systemPrompt
    : (agentActionsEnabled ? () => safeSystemPrompt().replace(NO_ACTION_RULE, AGENT_ACTION_RULE) : actionsEnabled ? () => watchSystemPrompt(undefined, { includeClock: false }) : safeSystemPrompt);
  const turnRules = opts.turnRules || ((text) => agentActionsEnabled ? text : actionsEnabled ? withWatchRules(text)
    : promptWithRules(text, [NO_ACTION_RULE]));
  const requestNow = opts.now || (() => new Date());
  const jobs = new Map();
  const requests = new Map(); // profile-local request id -> transcription/job state
  const ownedPending = new Map();
  function createPending(action) {
    for (const [id, at] of ownedPending) if (Date.now() - at > actions.CONFIRM_TTL_MS) ownedPending.delete(id);
    const id = actions.createPending(action);
    ownedPending.set(id, Date.now());
    return id;
  }
  function takePending(id) {
    if (!ownedPending.has(id)) return null;
    ownedPending.delete(id);
    return actions.takePending(id);
  }

  let session = readJson(opts.sessionFile);
  function currentSession() {
    if (!session || !session.id || Date.now() - (session.at || 0) > IDLE_MS) session = { id: newSessionId() };
    session.at = Date.now();
    const tmp = `${opts.sessionFile}.tmp`;
    fs.writeFile(tmp, JSON.stringify(session), (e) => { if (!e) fs.rename(tmp, opts.sessionFile, () => {}); });
    return session.id;
  }

  // The latest reply, for a watch that closed before it arrived (GET /watch/last).
  let last = null;
  function remember(reply) {
    if (reply && reply.ok) last = { reply, at: Date.now() };
    return reply;
  }

  // Turns the relay answers itself never reach Hermes' state.db; recordTurn keeps them for the
  // a conversation log (turns.jsonl), in the same watch session.
  function answered(heard, reply) {
    try { recordTurn({ ts: Date.now() / 1000, session: currentSession(), heard, reply: reply.text }); } catch { /* log only */ }
    return reply;
  }

  // A Hermes turn, streamed: the text is collected, and approval requests (Claude Code edits and
  // builds, dangerous commands) are handed to onApproval while Hermes waits for the answer.
  function askHermes(sessionId, userText, onApproval = () => {}, onProgress = () => {}) {
    let up;
    let streamResponse;
    let runId;
    if (opts.nativeRuns) {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const context = `[Watch request context: current local date and time: ${timeString(zone, zone, requestNow())}.]`;
      return createRun(opts, sessionId, systemPrompt(), `${turnRules(userText)}\n\n${context}`, onApproval, onProgress);
    }
    const promise = new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      // Keep changing clock text out of the system prefix and Hermes agent-cache key.
      // Fresh local time belongs with this turn so food logs still interpret today correctly.
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const context = `[Watch request context: current local date and time: ${timeString(zone, zone, requestNow())}.]`;
      const body = Buffer.from(JSON.stringify({ model: 'hermes-agent', stream: true, messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: `${turnRules(userText)}\n\n${context}` }] }));
      up = http.request({ host: '127.0.0.1', port: opts.hermesPort, method: 'POST', path: `${opts.hermesPathPrefix || ''}/v1/chat/completions`, headers: {
        authorization: `Bearer ${opts.hermesKey}`, 'content-type': 'application/json', 'content-length': body.length,
        'x-hermes-session-id': sessionId } }, (res) => {
        streamResponse = res;
        let buf = '';
        let text = '';
        const raw = [];
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (res.statusCode !== 200) return raw.push(c);
          buf += c.replace(/\r\n/g, '\n');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = (frame.match(/^event: *(.+)$/m) || [])[1] || 'message';
            const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            try {
              const payload = JSON.parse(data);
              if (payload.id && !runId) runId = payload.id;
              const progress = streamStage(event, payload);
              if (progress) onProgress(progress);
            } catch { /* heartbeat or DONE */ }
            if (event === 'approval.request') {
              try { onApproval(JSON.parse(data)); } catch (e) { log(`  bad approval event: ${e.message}`); }
            } else if (event === 'message' && data && data !== '[DONE]') {
              try { text += JSON.parse(data).choices[0].delta.content || ''; } catch { /* keep-alive or other frame */ }
            }
          }
        });
        res.on('end', () => done({ status: res.statusCode, text, raw: raw.join('') || text }));
        res.on('aborted', () => done({ status: 0, text: '', raw: 'Hermes closed the connection mid-answer' }));
      });
      up.on('error', e => done({ status: 0, text: '', raw: e.message }));
      up.on('close', () => done({ status: 0, text: '', raw: 'connection closed before an answer' }));
      up.end(body);
    });
    const cancel = why => {
      if (streamResponse) streamResponse.destroy();
      if (up) up.destroy(new Error(why));
    };
    return { promise, cancel, async stop() {
      // Prefer Hermes's exact run control. Closing this stream is its supported
      // disconnect/interrupt fallback, scoped to this one request and agent.
      let status = 0;
      if (runId) status = await stopRun(runId);
      cancel('Watch requested stop');
      return status;
    } };

  }

  function stopRun(runId) {
    return new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: opts.hermesPort, method: 'POST',
        path: `${opts.hermesPathPrefix || ''}/v1/runs/${encodeURIComponent(runId)}/stop`,
        headers: { authorization: `Bearer ${opts.hermesKey}`, 'content-type': 'application/json' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.setTimeout(2000, () => req.destroy(new Error('stop timed out')));
      req.on('error', () => resolve(0)); req.end('{}');
    });
  }

  const stoppedReply = heard => ({ ok: true, heard: heard || '', kind: 'answer', stopped: true,
    text: 'Stop requested. Anything already saved stays saved.' });

  async function stopRequest(body) {
    let ctx = body.rid && requests.get(String(body.rid));
    if (!ctx && !body.job && typeof body.rid === 'string' && body.rid.length > 0 && body.rid.length < 160) {
      ctx = { rid: body.rid, cancelled: true, at: Date.now() };
      requests.set(body.rid, ctx); // Stop can beat upload/transcription; fence its later arrival.
    }
    const entry = body.job ? jobs.get(String(body.job)) : ctx && ctx.entry;
    if (!entry && !ctx) return { ok: false, error: 'That watch request is no longer available.' };
    if (entry && entry.reply) return { ...entry.reply, already_finished: true };
    if (ctx) ctx.cancelled = true;
    if (!entry) return stoppedReply(''); // transcription may finish, but must never start Hermes
    if (entry.stopping) return entry.stopping;
    entry.cancelled = true; entry.progress = 'Stopping';
    entry.stopping = (async () => {
      const status = await entry.turn.stop();
      log(`  stop requested job=${entry.job} native_status=${status} run=${entry.turn.runId || "chat"}`);
      if (entry.turn.native && !(status >= 200 && status < 300)) {
        entry.cancelled = false; entry.stopping = null; entry.progress = 'Stop not confirmed';
        if (entry.pendingDone) {
          entry.reply = remember(toReply(entry.heard, entry.pendingDone));
          if (entry.wake) entry.wake();
          return { ...entry.reply, already_finished: true };
        }
        return { ok: false, error: 'Hermes did not confirm Stop. Try again.' };
      }
      for (const [id, a] of approvals) if (a.entry === entry) approvals.delete(id);
      entry.card = null;
      if (entry.pendingDone && entry.pendingDone.status === 200) {
        entry.reply = remember(toReply(entry.heard, entry.pendingDone));
        if (entry.wake) entry.wake();
        return { ...entry.reply, already_finished: true };
      }
      entry.reply = remember(stoppedReply(entry.heard));
      if (entry.wake) entry.wake();
      return entry.reply;
    })();
    return entry.stopping;
  }

  // POST /v1/runs/{id}/approval: once | deny. Resolves to Hermes' HTTP status (0 = no connection).
  function answerApproval(runId, choice, requestId) {
    return new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify({ choice, request_id: requestId }));
      const req = http.request({ host: '127.0.0.1', port: opts.hermesPort, method: 'POST',
        path: `${opts.hermesPathPrefix || ''}/v1/runs/${encodeURIComponent(runId)}/approval`, headers: {
          authorization: `Bearer ${opts.hermesKey}`, 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.setTimeout(10000, () => req.destroy(new Error('timed out')));
      req.on('error', () => resolve(0));
      req.end(body);
    });
  }

  // A finished Hermes turn as a watch reply: an answer, or a confirm card for a CONFIRM line.
  function toReply(heard, r) {
    if (r.status !== 200 || !r.text.trim()) {
      log(`  hermes ${r.status || 'no connection'}: ${String(r.raw).slice(0, 200)}`);
      let text = `Hermes error ${r.status}.`;
      if (r.status === 200) text = 'Hermes sent back an empty answer. Try asking again.';
      else if (r.status === 0) {
        text = /ECONNREFUSED/.test(r.raw) ? "Hermes isn't running on the PC right now." : 'Lost the connection to Hermes. Try again.';
      }
      return { ok: true, heard, kind: 'answer', text };
    }
    const { text, confirm } = splitConfirm(r.text);
    const body = truncateForHud(formatForHud(text), WATCH_CHAR_BUDGET);
    if (!confirm) return { ok: true, heard, kind: 'answer', text: body };
    const id = createPending({ kind: 'hermes', question: confirm });
    return { ok: true, heard, kind: 'confirm', text: body ? `${body}\n${confirm}` : confirm, id };
  }

  // Every Hermes turn is a job entry. The watch gets whichever comes first: the answer, an Approve
  // card, or (at the deadline) a job id to poll. A card that shows up later comes back from /watch/result.
  const approvals = new Map(); // card id -> {runId, requestId, job, entry}

  function settle(job, entry, until) {
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        entry.wake = null;
        resolve(collect(job, entry));
      };
      if (entry.card || entry.reply) return finish();
      timer = setTimeout(finish, Math.max(0, until - Date.now()));
      entry.wake = finish;
    });
  }

  // A card stays until it is answered and a finished answer stays (until JOB_KEEP_MS), so a
  // poll whose reply was lost on the way to the watch gets the same card or answer again.
  function collect(job, entry) {
    if (entry.card) return entry.card;
    if (entry.reply) return entry.reply;
    return { ok: true, heard: entry.heard, kind: 'working', job, rid: entry.rid, progress: entry.progress, elapsed_ms: Date.now() - entry.at, ...(entry.approved ? { note: BUILD_NOTE } : {}) };
  }

  async function hermesTurn(heard, userText, started, ctx = {}) {
    const sessionId = currentSession();
    const job = crypto.randomBytes(9).toString('base64url');
    const entry = { heard, at: started, reply: null, card: null, approved: false, wake: null,
      job, rid: ctx.rid || '', progress: 'Starting model', cancelled: false };
    ctx.entry = entry;
    jobs.set(job, entry);
    const turn = askHermes(sessionId, userText, (ev) => {
      if (entry.cancelled) return;
      const id = crypto.randomBytes(6).toString('hex');
      approvals.set(id, { runId: ev.run_id, requestId: ev.request_id, job, entry });
      const asked = String(ev.command || ev.description || 'Approve this?').replace(/\n\s*\n/g, '\n');
      entry.card = { ok: true, heard, kind: 'confirm', approve: true, text: truncateForHud(formatForHud(asked), WATCH_CHAR_BUDGET), id };
      log(`  approval asked (${ev.pattern_key || 'approval'}) card=${id} job=${job}`);
      if (entry.wake) entry.wake();
    }, progress => { if (!entry.cancelled) entry.progress = progress; });
    entry.turn = turn;
    const cap = setTimeout(() => turn.cancel('stopped waiting after 30 min'), JOB_CAP_MS);
    turn.promise.then((done) => {
      clearTimeout(cap);
      for (const [id, a] of approvals) if (a.entry === entry) approvals.delete(id);
      entry.card = null;
      if (entry.cancelled) { entry.pendingDone = done; return; }
      entry.reply = remember(toReply(heard, done));
      log(`  -> ${done.status} ${Date.now() - started}ms session=${sessionId} job=${job}`);
      if (notifyEnabled && entry.approved && entry.reply.text) notify(`From the watch: ${heard || 'your approval'}\n\n${entry.reply.text}`);
      if (entry.wake) entry.wake();
    });
    const reply = await settle(job, entry, started + deadlineMs);
    if (reply.kind === 'working') log(`  -> working after ${Date.now() - started}ms job=${job}`);
    return reply;
  }

  // Approve (once) or Deny a pending approval; Deny answers at once, Approve waits like a turn.
  async function approve(a, yes) {
    approvals.delete(a.id);
    if (a.entry.card && a.entry.card.id === a.id) a.entry.card = null; // answered: not shown again
    const status = await answerApproval(a.runId, yes ? 'once' : 'deny', a.requestId);
    log(`  approval ${yes ? 'once' : 'deny'} -> ${status}`);
    if (status !== 200) return { ok: true, kind: 'answer', text: 'That approval expired. Ask again.' };
    if (!yes) return { ok: true, kind: 'answer', text: 'OK, denied - nothing was changed.' };
    a.entry.approved = true;
    const { heard, ...reply } = await settle(a.job, a.entry, Date.now() + deadlineMs);
    return reply;
  }

  // A new question (or a spoken Reply to a card) means "not that": deny what is still waiting, so
  // the session isn't stuck behind it.
  function denyPending() {
    for (const [id, a] of approvals) {
      approvals.delete(id);
      if (a.entry.card && a.entry.card.id === id) a.entry.card = null;
      answerApproval(a.runId, 'deny', a.requestId).then(st => log(`  approval card=${id} denied by a new question -> ${st}`));
    }
  }

  function transcribe(audio) {
    return new Promise((resolve) => {
      const url = new URL(opts.sttUrl);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': audio.length } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* below */ }
          if (res.statusCode !== 200) return resolve({ error: body.error || `speech-to-text error ${res.statusCode}` });
          resolve({ text: String(body.text || '').trim() });
        });
      });
      req.setTimeout(30000, () => req.destroy(new Error('timed out')));
      req.on('error', () => resolve({ error: "Speech-to-text isn't running on the PC." }));
      req.end(audio);
    });
  }

  async function ask(body, ctx = {}) {
    const started = Date.now();
    let heard = typeof body.text === 'string' ? body.text.trim() : '';
    if (body.audio_b64 !== undefined) {
      const stt = await transcribe(Buffer.from(String(body.audio_b64), 'base64'));
      if (stt.error) return { ok: false, error: stt.error };
      heard = stt.text;
    }
    if (ctx.cancelled) return stoppedReply(heard);
    log(`ask: ${heard.slice(0, 120)}`);
    if (!heard) return { ok: true, heard, kind: 'answer', text: "I didn't catch that." };
    if (isResetCommand(heard)) {
      session = { id: newSessionId() };
      return answered(heard, { ok: true, heard, kind: 'answer', text: 'New session started.' });
    }
    if (!agentActionsEnabled && parsePcRestartCommand(heard) === 'cancel') {
      const text = cancelRestart();
      log(`  pc restart cancel: ${text}`);
      return answered(heard, { ok: true, heard, kind: 'answer', text });
    }
    if (!agentActionsEnabled && (isPcHealthRequest(heard) || MISHEARD_HEALTH.test(heard))) {
      const text = formatPcHealth(await pcHealth()); // not gathered -> Hermes answers instead
      if (text) {
        log(`  -> pc health ${Date.now() - started}ms`);
        return answered(heard, { ok: true, heard, kind: 'answer', text });
      }
    }
    // Direct actions (texts, car, PC restart) only when enabled; otherwise the words go to
    // Hermes like any other question.
    const action = actionsEnabled ? actions.parseAction(heard) : null;
    if (action) {
      const id = createPending(action);
      log(`  -> confirm ${action.kind}${action.tool ? ` ${action.tool}` : ''}`);
      return answered(heard, { ok: true, heard, kind: 'confirm', text: action.summary, id });
    }
    denyPending();
    return hermesTurn(heard, heard, started, ctx);
  }

  async function confirm(body, ctx = {}) {
    const pendingApproval = approvals.get(String(body.id || ''));
    if (pendingApproval) { ctx.entry = pendingApproval.entry; return approve({ id: String(body.id), ...pendingApproval }, !!body.yes); }
    const action = takePending(String(body.id || ''));
    if (!action) return { ok: true, kind: 'answer', text: 'That expired, ask again.' };
    if (action.kind === 'hermes' && !body.yes) {
      // Nothing to wait for on a No (Hermes once took 3+ min to reply to it): answer now and
      // tell Hermes in the background so the draft or offer is dropped in its session.
      const turn = askHermes(currentSession(), "no, don't");
      const cap = setTimeout(() => turn.cancel('stopped waiting after 10 min'), JOB_CAP_MS);
      turn.promise.then((done) => { clearTimeout(cap); log(`  (no, in background) -> ${done.status}`); });
      return { ok: true, kind: 'answer', text: 'OK, not doing it.' };
    }
    if (action.kind === 'hermes') {
      const reply = await hermesTurn('', 'yes, go ahead', Date.now(), ctx);
      delete reply.heard;
      return reply;
    }
    if (!body.yes) return answered('No', { ok: true, kind: 'answer', text: action.kind === 'text' ? 'OK, not sent.' : 'OK, not doing it.' });
    log(`  confirm yes: ${action.kind}${action.tool ? ` ${action.tool}` : ''}`);
    const r = await runAction(action);
    log(`  action ${r.ok ? 'ok' : 'failed'}: ${String(r.message).slice(0, 120)}`);
    return answered('Yes', { ok: true, kind: 'answer', text: r.message });
  }

  // Spoken answers (Voice on the watch): a reply the watch asked to hear gets a speech id and its MP3
  // is started at once, in parallel with the text going out; the phone fetches it from
  // GET /watch/speech?id=. Speech never delays an answer, and nothing is made while Voice is off.
  // A long answer is spoken as two clips (splitSpeech): the short first sentence reaches the
  // watch over Bluetooth fast and plays while the rest is still on its way.
  const speeches = new Map(); // id -> {parts: [text], audio: [Promise<Buffer>|null], at}

  function withSpeech(reply, speak) {
    if (!speak || !reply || !reply.ok || reply.stopped || reply.approve || !['answer', 'confirm'].includes(reply.kind)) return reply;
    const text = speechText(reply.text || '');
    if (!text) return reply;
    for (const [k, v] of speeches) if (Date.now() - v.at > JOB_KEEP_MS) speeches.delete(k);
    const id = crypto.randomBytes(6).toString('hex');
    const parts = splitSpeech(text);
    // Started now, so they're (nearly) ready by the time the phone asks for them.
    const audio = parts.map((p) => {
      const a = tts(p);
      a.catch(() => {}); // a failure is reported when the phone fetches it
      return a;
    });
    speeches.set(id, { parts, audio, at: Date.now() });
    return { ...reply, speech: id, ...(parts.length > 1 ? { speechParts: parts.length } : {}) };
  }

  // GET /watch/speech?id=&part=N (part 1 when left out).
  function speechAudio(id, part, res, send) {
    const entry = speeches.get(id);
    const i = (Number(part) || 1) - 1;
    if (!entry || i < 0 || i >= entry.parts.length) return send(404, { ok: false, error: 'no such speech' });
    const started = Date.now();
    if (!entry.audio[i]) entry.audio[i] = tts(entry.parts[i]);
    entry.audio[i].then((mp3) => {
      log(`  speech ${id}.${i + 1}: ${entry.parts[i].length} chars -> ${mp3.length} B in ${Date.now() - started}ms`);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length });
      res.end(mp3);
    }, (e) => {
      entry.audio[i] = null; // a later fetch tries again
      log(`  speech ${id}.${i + 1} failed: ${e.message}`);
      send(502, { ok: false, error: `voice failed: ${e.message}` });
    });
  }

  const replies = new Map(); // "<path> <rid>" -> {promise, at}

  function result(job, speak) {
    for (const [id, j] of jobs) if (Date.now() - j.at > JOB_KEEP_MS) jobs.delete(id);
    const entry = jobs.get(job);
    if (!entry) return { ok: true, kind: 'answer', text: 'That answer is no longer here. Ask again.' };
    const reply = collect(job, entry);
    if (reply.kind === 'working') return reply;
    log(`  result collected job=${job}${reply.approve ? ' (approval card)' : ''}`);
    const out = reply.heard === '' ? (({ heard, ...rest }) => rest)(reply) : reply;
    if (!speak) return out;
    // One speech id per reply, so polling again (after a lost reply) doesn't make the audio twice.
    if (entry.spokenFrom !== reply) {
      entry.spokenFrom = reply;
      entry.spokenReply = withSpeech(out, true);
    }
    return entry.spokenReply;
  }

  function probe(host, port, p) {
    return new Promise((resolve) => {
      const req = http.get({ host, port, path: p, timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
  }

  return http.createServer((req, res) => {
    const send = (code, obj) => {
      if (res.headersSent) return;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url || '/', 'http://watch');
    if (!['/watch/ask', '/watch/confirm', '/watch/diag'].includes(url.pathname)) log(`${req.method} ${url.pathname}${url.search}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const stt = new URL(opts.sttUrl);
      return Promise.all([probe(stt.hostname, stt.port, '/health'), probe('127.0.0.1', opts.hermesPort, `${opts.hermesPathPrefix || ''}/health`)])
        .then(([sttOk, hermesOk]) => send(200, { ok: true, stt: sttOk, hermes: hermesOk }));
    }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const good = Buffer.from(String(opts.token || ''));
    const given = Buffer.from(token);
    if (!opts.token || given.length !== good.length || !crypto.timingSafeEqual(given, good)) return send(401, { ok: false, error: 'bad token' });
    if (req.method === 'GET' && url.pathname === '/watch/result') {
      return send(200, result(url.searchParams.get('job') || '', url.searchParams.get('speak') === '1'));
    }
    if (req.method === 'GET' && url.pathname === '/watch/speech') {
      return speechAudio(url.searchParams.get('id') || '', url.searchParams.get('part'), res, send);
    }
    if (req.method === 'GET' && url.pathname === '/watch/last') {
      return send(200, last ? { ...last.reply, ago_ms: Date.now() - last.at } : { ok: true, kind: 'none' });
    }
    if (req.method !== 'POST' || !['/watch/ask', '/watch/confirm', '/watch/result', '/watch/diag', '/watch/stop'].includes(url.pathname)) return send(404, { ok: false, error: 'not found' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return send(413, { ok: false, error: 'recording too long' });
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      if (!body || typeof body !== 'object') return send(400, { ok: false, error: 'bad request' });
      // Status lines from the phone (side service) and the watch, whose own logs aren't visible
      // from the PC: one short line each, so they can't inject fake log lines.
      if (url.pathname === '/watch/diag') {
        const from = body.from === 'watch' ? 'watch' : 'phone';
        for (const e of (Array.isArray(body.events) ? body.events : []).slice(0, 20)) {
          log(`  ${from}: ${String(e).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
        }
        return send(200, { ok: true });
      }
      if (url.pathname === '/watch/result') return send(200, result(String(body.job || ''), body.speak));
      if (url.pathname === '/watch/stop') {
        stopRequest(body).then(r => send(200, r)).catch(() => send(200, { ok: false, error: 'Could not request stop. Try again.' }));
        return;
      }
      // The phone retries a request whose reply got lost with the same rid; it gets the same
      // reply (waiting for it if still running), so Hermes and actions run once.
      const key = typeof body.rid === 'string' && body.rid ? `${url.pathname} ${body.rid}` : '';
      for (const [k, v] of replies) if (Date.now() - v.at > JOB_KEEP_MS) replies.delete(k);
      let reply = key && replies.has(key) ? replies.get(key).promise : null;
      if (reply) log(`  retry ${key}`);
      else {
        const ctx = requests.get(body.rid) || { rid: typeof body.rid === 'string' ? body.rid : '', cancelled: false };
        if (ctx.rid) requests.set(ctx.rid, ctx);
        for (const [rid, old] of requests) if (old.at && Date.now() - old.at > JOB_KEEP_MS) requests.delete(rid);
        ctx.at = Date.now();
        reply = (url.pathname === '/watch/ask' ? ask(body, ctx) : confirm(body, ctx)).then(remember)
          .then(r => withSpeech(r, body.speak))
          .catch((e) => { log(`relay error: ${e.stack || e}`); return { ok: false, error: `Relay error: ${e.message}` }; });
        if (key) replies.set(key, { promise: reply, at: Date.now() });
      }
      reply.then(r => send(200, r));
    });
  });
}

// What the watch reads out: bullets and lines become sentences, links go, and a long answer stops
// at the last whole sentence within SPEECH_CHARS (the screen still has all of it).
const SPEECH_CHARS = 400;
function speechText(text) {
  const plain = String(text)
    .replace(/https?:\/\/\S+/g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*[•\-*]\s*/, '').replace(/\s+([.,!?])/g, '$1').trim())
    .filter(Boolean)
    .map(l => (/[.!?:]$/.test(l) ? l : `${l}.`))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
  if (plain.length <= SPEECH_CHARS) return plain;
  const cut = plain.slice(0, SPEECH_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 0 ? cut.slice(0, end + 1) : cut;
}

// Spoken text -> clips. Up to SPLIT_MIN chars it's one clip; longer, the first sentence (at most
// FIRST_CHARS, else cut at a word) is clip 1 and the rest clip 2. Clip 1 is small (a few KB), so
// the voice starts ~1-2 s after the text even when the whole answer is ~40 KB of audio.
const SPLIT_MIN = 120;
const FIRST_CHARS = 160;
function splitSpeech(text) {
  if (text.length <= SPLIT_MIN) return [text];
  const end = text.search(/[.!?](\s|$)/);
  let first = end >= 0 && end < FIRST_CHARS ? text.slice(0, end + 1) : '';
  if (!first) {
    const cut = text.slice(0, FIRST_CHARS);
    const space = cut.lastIndexOf(' ');
    first = space > 40 ? cut.slice(0, space) : cut;
  }
  const rest = text.slice(first.length).trim();
  return rest ? [first.trim(), rest] : [text];
}

// POST {text} to the speech worker's /tts -> MP3 Buffer.
function postTts(url, text) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ text }));
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const out = Buffer.concat(chunks);
        if (res.statusCode === 200) return resolve(out);
        reject(new Error(`speech worker ${res.statusCode}: ${out.toString('utf8').slice(0, 120)}`));
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('speech timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { createServer, newSessionId, speechText, splitSpeech, DEFAULT_DEADLINE_MS };

if (require.main === module) {
  const LOG_FILE = path.join(__dirname, 'relay.log');
  const log = line => fs.appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`, () => {});
  const config = readJson(process.env.WATCH_CONFIG || path.join(__dirname, 'config.json')) || {};
  const envFiles = [
    process.env.HERMES_ENV_FILE,
    process.env.HERMES_HOME && path.join(process.env.HERMES_HOME, '.env'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'hermes', '.env'),
  ].filter(Boolean);
  let envText = '';
  let envFile = envFiles[0] || '.env';
  for (const candidate of envFiles) {
    try { envText = fs.readFileSync(candidate, 'utf8'); envFile = candidate; break; } catch { /* try next */ }
  }
  const envValue = (name) => {
    const m = envText.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const hermesKey = envValue('API_SERVER_KEY');
  // Results of builds approved on the watch also go to Hermes' Telegram home chat (buzzes the watch).
  const telegram = { token: envValue('TELEGRAM_BOT_TOKEN'), chat: envValue('TELEGRAM_HOME_CHANNEL'),
    thread: envValue('TELEGRAM_HOME_CHANNEL_THREAD_ID') };
  // Tried 3 times (a network blip once lost a build result); connection failures can come as an
  // AggregateError with an empty message, so the log shows the code too.
  const notify = (text, attempt = 1) => {
    if (!telegram.token || !telegram.chat) return log('  telegram: no bot token / home channel in .env');
    const body = Buffer.from(JSON.stringify({ chat_id: telegram.chat, text: `⌚ ${text}`.slice(0, 4000),
      ...(telegram.thread ? { message_thread_id: Number(telegram.thread) } : {}) }));
    const again = (why) => {
      log(`  telegram failed (try ${attempt}): ${why}`);
      if (attempt < 3) setTimeout(() => notify(text, attempt + 1), attempt * 10000);
    };
    const req = https.request({ host: 'api.telegram.org', method: 'POST', path: `/bot${telegram.token}/sendMessage`,
      headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      res.resume();
      if (res.statusCode >= 500 || res.statusCode === 429) return again(`HTTP ${res.statusCode}`);
      log(`  telegram -> ${res.statusCode}`);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timed out')));
    req.on('error', e => again([e.code, e.message, ...(e.errors || []).map(x => x.code)].filter(Boolean).join(' ') || e.name));
    req.end(body);
  };
  if (!config.token) { console.error('config.json needs a "token" (see config.example.json)'); process.exit(1); }
  if (!hermesKey) { console.error(`API_SERVER_KEY not found in ${envFile}`); process.exit(1); }
  // Normal Hermes tools handle user requests. Legacy relay shortcuts and Telegram delivery remain optional.
  const actionsEnabled = process.env.WATCH_ACTIONS === '1';
  const notifyEnabled = process.env.WATCH_NOTIFY === '1';
  const port = Number(process.env.WATCH_PORT) || 8798;
  const defaultOptions = {
    token: config.token,
    hermesKey,
    nativeRuns: true,
    hermesPort: Number(process.env.WATCH_HERMES_PORT) || 8643,
    sttUrl: process.env.WATCH_STT_URL || 'http://127.0.0.1:8797/stt',
    sessionFile: process.env.WATCH_SESSION_FILE || path.join(__dirname, 'session.json'),
    deadlineMs: Number(process.env.WATCH_DEADLINE_MS) || DEFAULT_DEADLINE_MS,
    actionsEnabled,
    agentActionsEnabled: process.env.WATCH_AGENT_ACTIONS !== '0',
    notifyEnabled,
    log,
    recordTurn: e => fs.appendFile(process.env.WATCH_TURNS_FILE || path.join(__dirname, 'turns.jsonl'),
      `${JSON.stringify(e)}\n`, () => {}),
    notify: notifyEnabled ? notify : () => {},
  };
  const healthHome = process.env.WATCH_HEALTH_HOME || path.join(path.dirname(envFile), 'profiles', 'health');
  let healthKey = '';
  try {
    const text = fs.readFileSync(path.join(healthHome, '.env'), 'utf8');
    const match = text.match(/^\s*API_SERVER_KEY\s*=\s*(.+)$/m);
    healthKey = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { /* Health must fail closed; never reuse the default profile key. */ }
  const healthOptions = {
    ...defaultOptions,
    hermesKey: healthKey,
    hermesPathPrefix: '/p/health',
    sessionFile: path.join(__dirname, 'session-health.json'),
    actionsEnabled: false,
    notifyEnabled: false,
    notify: () => {},
    log: line => fs.appendFile(path.join(__dirname, 'relay-health.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }, () => {}),
    recordTurn: e => fs.appendFile(path.join(__dirname, 'turns-health.jsonl'), `${JSON.stringify(e)}\n`, { mode: 0o600 }, () => {}),
  };
  const { createProfileServer } = require('./lib/profile-router');
  createProfileServer(createServer, { default: defaultOptions, health: healthOptions })
    .listen(port, '127.0.0.1', () => log(`watch relay listening on 127.0.0.1:${port}; profiles=default,health`));
}
