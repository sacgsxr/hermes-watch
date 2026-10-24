import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { checkedProfile, profilePath, savedScreenKey, scopedRequest } from '../shared/profiles.js'

test('profile requests and saved screens are scoped; unknown profiles fail closed', () => {
  assert.equal(profilePath('health', '/watch/last'), '/p/health/watch/last')
  assert.notEqual(savedScreenKey('health'), savedScreenKey('default'))
  assert.throws(() => checkedProfile('finance'))
  const req = { method: 'result', params: { job: 'abc' } }
  assert.deepEqual(scopedRequest(req, 'health').params, { job: 'abc', profile: 'health' })
  assert.equal(req.params.profile, undefined)
})

test('watch switch stops old speech and refuses delayed replies/audio from the other profile', () => {
  let page
  const storage = new Map()
  const source = readFileSync(new URL('../page/index.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
  vm.runInNewContext(source, {
    Page: p => page = p, BasePage: p => p, getDeviceInfo: () => ({ width: 466, height: 466 }),
    ringDots: () => [], checkedProfile, savedScreenKey, scopedRequest,
    localStorage: { setItem: (k,v) => storage.set(k,v) },
  })
  let stopped = 0, displayed = 0
  const deleted = []
  page.stopVoice = () => stopped++
  page.clearTimers = () => {}
  page.deleteFile = file => deleted.push(file)
  page.show = () => displayed++
  page.state.earlyFiles = [{ path: 'old.mp3' }]
  page.switchProfile('health')
  assert.equal(stopped, 1)
  assert.equal(page.state.profile, 'health')
  assert.equal(storage.get('selected-profile'), 'health')
  assert.deepEqual(deleted, ['old.mp3'])
  page.finish({ __profile: 'default', text: 'wrong conversation' })
  assert.equal(displayed, 1)
  page.playSpeech('late.mp3', { profile: 'default', id: 'old' })
  assert.deepEqual(deleted, ['old.mp3', 'late.mp3'])
  page.state.busy = true
  page.switchProfile('default')
  assert.equal(page.state.profile, 'health')
})

test('retry stops when the selected profile changes instead of rerouting an old request', async () => {
  let page, sends = 0
  const source = readFileSync(new URL('../page/index.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
  vm.runInNewContext(source, {
    Page: p => page = p, BasePage: p => p, getDeviceInfo: () => ({ width: 466, height: 466 }),
    ringDots: () => [], checkedProfile, savedScreenKey, scopedRequest,
    resendUntil: async attempt => {
      await attempt()
      page.state.profile = 'default'
      page.state.profileEpoch++
      return attempt()
    },
  })
  page.state.profile = 'health'
  page.phoneRequest = async (req, opts, profile) => { sends++; assert.equal(profile, 'health'); return { retry: true } }
  const result = await page.resendRequest({ method: 'result' }, {}, 10)
  assert.equal(sends, 1)
  assert.equal(result.__profile, 'health')
  assert.equal(result.error, 'Profile changed')
})
