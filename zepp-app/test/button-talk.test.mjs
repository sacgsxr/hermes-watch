import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { resumeFor } from '../shared/screens.js'
import { checkedProfile, savedScreenKey, scopedRequest } from '../shared/profiles.js'

for (const screen of [null, 'answer', 'confirm', 'working']) {
  test(`opening app with ${screen || 'fresh'} state ${screen === 'confirm' || screen === 'working' ? 'resumes pending work' : 'starts listening'}`, () => {
    let page, talked = 0, fetched = 0
    const shown = [], timers = []
    const saved = screen ? { at: Date.now(), since: Date.now(), model: { screen, text: 'saved', approve: true } } : null
    const source = readFileSync(new URL('../page/index.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
    vm.runInNewContext(source, {
      Page: p => page = p, BasePage: p => p, getDeviceInfo: () => ({ width: 466, height: 466 }),
      ringDots: () => [], checkedProfile, savedScreenKey, scopedRequest, resumeFor,
      localStorage: { getItem: (key, fallback) => key === 'selected-profile' ? 'health' : key === 'last-screen:health' ? JSON.stringify(saved) : fallback },
      setTimeout: fn => { timers.push(fn); return timers.length },
    })
    page.onTalk = () => talked++
    page.show = m => shown.push(m.screen)
    page.keepAwake = () => {}
    page.fetchLast = () => fetched++
    page.build()
    assert.equal(page.state.profile, 'health')
    assert.equal(talked, 0)
    for (const timer of timers) timer()
    assert.equal(talked, screen === 'confirm' || screen === 'working' ? 0 : 1)
    assert.equal(fetched, screen === 'working' ? 1 : 0)
    if (screen === 'confirm') assert.deepEqual(shown, ['confirm'])
  })
}
