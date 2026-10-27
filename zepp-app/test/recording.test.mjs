// Run (in zepp-app): node --test test/recording.test.mjs
// The recorder contract (start/stop/event.STOP) and the stop path are exercised against page/index.js
// in a vm sandbox with a fake @zos/media recorder, the same way button-talk.test.mjs drives the page.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { checkedProfile, savedScreenKey, scopedRequest } from '../shared/profiles.js'
import { untilPhoneWakes, phoneError, resendUntil, newRid } from '../shared/retry.js'
import { screenFor, pollStep, resumeFor, lastIsNew } from '../shared/screens.js'
import { buildEnvelope } from '../shared/envelope.js'
import { DIAG } from '../shared/debug.js'

const PAGE_SOURCE = readFileSync(new URL('../page/index.js', import.meta.url), 'utf8')

// Fake @zos/media recorder: the STOP event is delivered by the test, like firmware would.
function fakeRecorder() {
  const listeners = {}
  return {
    started: 0, stopped: 0, format: null,
    event: { STOP: 'stop' },
    setFormat(codecName, opts) { this.format = { codecName, ...opts } },
    start() { this.started++ },
    stop() { this.stopped++ },
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn) },
    fireStop(success = true) { for (const fn of listeners[success ? 'stop' : 'failed'] || []) fn(success) },
  }
}

function loadPage() {
  let page
  const scheduled = [] // every setTimeout/setInterval callback the page scheduled, in order
  const clip = { size: 0 } // what readClip() finds on disk; tests set clip.size once recording "finishes"
  const sandbox = {
    Page: (p) => { page = p }, BasePage: (p) => p,
    getDeviceInfo: () => ({ width: 466, height: 466 }),
    ringDots: () => [], dotColors: () => [], elapsedText: (ms) => `${Math.round(ms / 1000)}s`, dotsText: () => '',
    checkedProfile, savedScreenKey, scopedRequest,
    untilPhoneWakes, phoneError, resendUntil, newRid,
    screenFor, pollStep, resumeFor, lastIsNew,
    buildEnvelope, DIAG,
    localStorage: { getItem: (k, f) => f, setItem() {}, removeItem() {} },
    create: () => fakeRecorder(), id: { RECORDER: 'recorder' }, codec: { OPUS: 1 },
    rmSync() {}, statSync: () => (clip.size ? { size: clip.size } : null),
    openSync: () => 1, readSync({ buffer }) { new Uint8Array(buffer).fill(1) }, closeSync() {}, O_RDONLY: 0,
    queryPermission: () => [2], requestPermission: () => 2,
    hmUI: {
      widget: { TEXT: 'text', BUTTON: 'button', CIRCLE: 'circle', IMG: 'img' },
      createWidget: () => ({ setProperty() {} }), deleteWidget() {},
      getTextLayout: () => ({ height: 20 }),
      align: { CENTER_H: 1 }, text_style: { WRAP: 1 }, prop: { TEXT: 'text', MORE: 'more' },
    },
    scrollTo() {},
    setPageBrightTime() {}, resetPageBrightTime() {}, pauseDropWristScreenOff() {}, resetDropWristScreenOff() {},
    Vibrator: class { start() {} },
    setTimeout: (fn) => { scheduled.push(fn); return scheduled.length },
    setInterval: (fn) => { scheduled.push(fn); return scheduled.length },
    clearTimeout() {}, clearInterval() {},
  }
  vm.runInNewContext(PAGE_SOURCE.replace(/^import .*$/gm, ''), sandbox)
  // The phone is out of reach in the test: every request fails fast, so send() ends in an error screen.
  page.request = () => Promise.reject(new Error('no phone in the test'))
  return { page, scheduled, clip }
}

function startRecording(page) {
  page.onTalk() // not recording yet: this starts it (mic permission is faked as granted)
  assert.equal(page.state.recording, true)
  const rec = page.state.recorder
  assert.ok(rec && rec.started === 1, 'recorder.start() called once')
  return rec
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the automatic maximum recording duration is exactly 30000 ms', () => {
  assert.match(PAGE_SOURCE, /^const MAX_REC_MS = 30000$/m)
})

test('the recorder contract: start(), stop() and the STOP event are used from the source', () => {
  assert.match(PAGE_SOURCE, /recorder\.addEventListener\(this\.state\.recorder\.event\.STOP/)
  assert.match(PAGE_SOURCE, /this\.state\.recorder\.start\(\)/)
  assert.match(PAGE_SOURCE, /this\.state\.recorder\.stop\(\)/)
})

test('tapping STOP stops the recorder and submits the completed clip on the STOP event', async () => {
  const { page } = loadPage()
  const rec = startRecording(page)
  let sent = 0
  page.send = () => { sent++; return Promise.resolve() }
  page.onTalk() // tap STOP while recording
  assert.equal(rec.stopped, 1)
  assert.equal(page.state.recording, false)
  await tick()
  assert.equal(sent, 0, 'nothing is submitted before the recorder reports done')
  rec.fireStop()
  assert.equal(sent, 1)
})

test('a second STOP event or a repeated tap does not submit twice', async () => {
  const { page, clip } = loadPage()
  const rec = startRecording(page)
  let requests = 0
  page.request = (req) => { requests++; return new Promise(() => {}) } // the reply never comes: send stays in flight
  page.onTalk() // tap STOP
  clip.size = 16
  rec.fireStop()
  await tick()
  assert.equal(requests, 1)
  rec.fireStop() // firmware delivered the event twice while the reply is still pending
  page.onTalk() // tap again while busy: ignored, no second stop or submit
  await tick()
  assert.equal(rec.stopped, 1)
  assert.equal(requests, 1, 'the clip was submitted exactly once')
})

test('a STOP event fired while a new recording is in progress cannot submit the old clip', async () => {
  const { page, clip } = loadPage()
  const rec = startRecording(page)
  let requests = 0
  page.request = (req) => { requests++; return Promise.resolve({ ok: true, text: 'hi' }) }
  page.onTalk() // tap STOP; the file is "written" when the recorder reports done
  clip.size = 16
  rec.fireStop()
  await new Promise((resolve) => setTimeout(resolve, 20)) // the reply arrives; the user can talk again
  assert.equal(page.state.busy, false)
  assert.equal(requests, 1)
  page.onTalk() // TALK: a fresh recording starts on the same recorder instance
  assert.equal(page.state.recording, true)
  rec.fireStop() // the first stop's event arrives late, while recording again
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(requests, 1, 'the late event submitted nothing')
})

test('firmware that omits the STOP event still gets a bounded fallback send', async () => {
  const { page, scheduled } = loadPage()
  startRecording(page)
  let sent = 0
  page.send = () => { sent++; return Promise.resolve() }
  page.onTalk() // tap STOP; no STOP event will ever come
  assert.equal(sent, 0)
  for (const fn of scheduled.splice(0)) fn() // run every pending timer (incl. the fallback)
  await tick()
  assert.equal(sent, 1, 'the fallback timer submits exactly once')
})

test('send() reads the finished clip and submits it to the phone once', async () => {
  const { page, clip } = loadPage()
  const rec = startRecording(page)
  let requests = 0
  page.request = (req) => { requests++; return Promise.resolve({ ok: true, text: 'hi' }) }
  page.onTalk() // tap STOP; the file is "written" when the recorder reports done
  clip.size = 16
  rec.fireStop()
  await new Promise((resolve) => setTimeout(resolve, 20)) // let the request pipeline settle
  assert.equal(requests, 1)
  assert.equal(page.state.busy, false, 'the reply finished')
})

test('no fixed 400 ms post-stop read race remains', () => {
  assert.doesNotMatch(PAGE_SOURCE, /setTimeout\(\(\) => this\.send\(\), 400\)/)
})

for (const [screen, note] of [['idle', 'starts listening on open'], ['answer', 'shows the saved screen']]) {
  test(`page still loads and builds with a ${screen} save (${note})`, () => {
    const { page } = loadPage()
    page.build()
    assert.equal(page.state.profile, 'default')
    assert.equal(page.state.recorder, null)
  })
}


test('explicit Stop targets the active job and fences a late original response', async () => {
  const { page } = loadPage();
  page.state.busy = true;
  page.state.pendingRid = 'r1';
  page.model = { screen: 'working', job: 'j1', rid: 'r1' };
  let resolveOld;
  const calls = [];
  page.phoneRequest = req => {
    calls.push(req);
    if (req.method === 'stop') return Promise.resolve({ ok: true, kind: 'answer', text: 'Stop requested.', stopped: true });
    return new Promise(resolve => { resolveOld = resolve; });
  };
  const old = page.resendRequest({ method: 'confirm', params: { rid: 'r1' } }, {}, 25000);
  await tick();
  await page.stopRequest();
  assert.equal(calls[1].method, 'stop');
  assert.equal(calls[1].params.job, 'j1');
  assert.equal(calls[1].params.rid, 'r1');
  assert.equal(page.model.text, 'Stop requested.');
  resolveOld({ ok: true, kind: 'answer', text: 'stale original reply' });
  page.finish(await old);
  assert.equal(page.model.text, 'Stop requested.');
  assert.equal(page.state.busy, false);
});

test('progress polling updates the visible stage while preserving the request', async () => {
  const { page, scheduled } = loadPage();
  page.phoneRequest = () => Promise.resolve({ ok: true, kind: 'working', progress: 'Checking food entry' });
  page.startPoll({ screen: 'working', job: 'j1', rid: 'r1', progress: 'Starting model' });
  scheduled[scheduled.length - 1]();
  await tick();
  assert.equal(page.state.progress, 'Checking food entry');
  assert.equal(page.model.progress, 'Checking food entry');
  assert.equal(page.model.job, 'j1');
  assert.equal(page.state.busy, true);
});


test('failed Stop keeps the target available rather than claiming cancellation', async () => {
  const { page } = loadPage();
  page.model = { screen: 'working', job: 'j1', rid: 'r1' };
  page.state.busy = true;
  page.state.pendingRid = 'r1';
  page.phoneRequest = () => Promise.resolve({ ok: false, error: 'Phone unavailable' });
  await page.stopRequest();
  assert.equal(page.model.job, 'j1');
  assert.equal(page.model.progress, 'Stop not confirmed');
  assert.equal(page.state.busy, true);
  assert.equal(page.state.stopping, false);
});
