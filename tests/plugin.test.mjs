import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(here, '..', 'desktop', 'plugin.js')
const ID = 'hermes-make-plain'

// The plugin runs in the renderer against the SDK's host. Tests evaluate the
// real shipped source with imports stripped and the SDK surface injected, so
// every assertion runs against the production code with no node_modules.
const source = fs.readFileSync(ENTRY, 'utf8')
const body = source
  .replace(/^import .*$/gm, '')
  .replace('export default', 'return')

const M = () => globalThis.__mock
const host = {
  state: { focusedSessionId: { get: () => M().focusedSid ?? null } },
  request: (...args) => {
    M().requests.push(args)
    return M().onRequest ? M().onRequest(...args) : Promise.resolve({})
  },
  notify: (n) => { M().notifies.push(n) },
  composer: {
    getDraft: (sid) => {
      M().getDrafts.push(sid)
      return M().onGetDraft ? M().onGetDraft(sid) : Promise.resolve(null)
    },
    setDraft: (sid, text) => {
      M().setDrafts.push({ sid, text })
      return M().onSetDraft ? M().onSetDraft(sid, text) : Promise.resolve(true)
    },
    insertText: () => Promise.resolve(true),
    submit: () => true,
    focus: () => {}
  }
}
const Button = 'Button'
const Tip = 'Tip'
const usePluginI18n = (id) => (key) => {
  const bundles = M().i18n[id]
  const en = bundles && bundles.en
  return en && key in en ? en[key] : key
}
function useState(initial) {
  const store = globalThis.__hookStore
  const i = globalThis.__hookIdx++
  if (!(i in store)) store[i] = initial
  const set = (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v }
  return [store[i], set]
}
const jsx = (type, props) => ({ type, props: props ?? {} })
const jsxs = jsx

const plugin = new Function('Button', 'host', 'Tip', 'usePluginI18n', 'useState', 'jsx', 'jsxs', body)(
  Button, host, Tip, usePluginI18n, useState, jsx, jsxs
)

function resetMock() {
  globalThis.__hookEpoch = (globalThis.__hookEpoch || 0) + 1
  installDocumentStub()
  globalThis.__mock = {
    i18n: {},
    registrations: [],
    notifies: [],
    requests: [],
    getDrafts: [],
    setDrafts: [],
    storage: new Map(),
    focusedSid: null,
    onRequest: null,
    onGetDraft: null,
    onSetDraft: null
  }
}

// Minimal document stub: the plugin owns its style tag (spinner keyframes) and
// looks it up by id, exactly like the real app document would.
function installDocumentStub() {
  const styles = new Map()
  globalThis.document = {
    head: {
      appendChild: (el) => {
        if (el && el.id) styles.set(el.id, el)
      }
    },
    createElement: () => ({
      id: '',
      textContent: '',
      remove() {
        styles.delete(this.id)
      }
    }),
    getElementById: (id) => styles.get(id) || null
  }
  globalThis.__styles = styles
}

function makeCtx() {
  const disposes = []
  const mock = globalThis.__mock
  const ctx = {
    i18n: { register: (b) => { mock.i18n[ID] = b } },
    storage: {
      set: (k, v) => mock.storage.set(k, v),
      get: (k) => mock.storage.get(k),
      remove: (k) => mock.storage.delete(k)
    },
    register: (rec) => mock.registrations.push(rec),
    onDispose: (fn) => disposes.push(fn)
  }
  return { ctx, disposes }
}

function render(root) {
  const nodes = []
  const epoch = globalThis.__hookEpoch || 0
  const walk = (node) => {
    if (node == null || typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.type === 'function') {
      // Per component instance hook store, kept across re-renders of the same
      // test (reset by the epoch bump in resetMock).
      const fn = node.type
      const byEpoch = fn.__hooksByEpoch || (fn.__hooksByEpoch = {})
      globalThis.__hookStore = byEpoch[epoch] || (byEpoch[epoch] = {})
      globalThis.__hookIdx = 0
      walk(fn(node.props))
      return
    }
    nodes.push(node)
    if (node.props && node.props.children) walk(node.props.children)
  }
  walk(root)
  return nodes
}

function mountButton() {
  const mock = globalThis.__mock
  const contrib = mock.registrations.find((r) => r.area === 'composer.actions')
  assert.ok(contrib, 'composer.actions contribution registered')
  const nodes = render(contrib.render())
  const btn = nodes.find((n) => n.type === 'Button')
  assert.ok(btn, 'Button rendered in the slot')
  return btn
}

function registerFresh() {
  resetMock()
  const { ctx, disposes } = makeCtx()
  plugin.register(ctx)
  return { disposes }
}

const tests = {}
const t = (name, fn) => { tests[name] = fn }

t('register: one composer.actions slot, i18n + heartbeat + style + dispose', () => {
  const { disposes } = registerFresh()
  const mock = globalThis.__mock
  assert.strictEqual(mock.registrations.length, 1)
  assert.strictEqual(mock.registrations[0].area, 'composer.actions')
  assert.strictEqual(mock.registrations[0].id, 'button')
  assert.ok(mock.i18n[ID].en && mock.i18n[ID].zh, 'en and zh bundles registered')
  const hb = mock.storage.get('heartbeat')
  assert.strictEqual(hb.version, '0.3.6')
  assert.strictEqual(disposes.length, 1)
  assert.ok(globalThis.document.getElementById('hermes-make-plain-style'), 'spinner style tag injected')
  const btn = mountButton()
  assert.ok(btn.props['aria-label'], 'button labelled')
})

t('i18n: en/zh key parity, zh values carry no English words', () => {
  registerFresh()
  const bundles = globalThis.__mock.i18n[ID]
  const enKeys = Object.keys(bundles.en).sort()
  const zhKeys = Object.keys(bundles.zh).sort()
  assert.deepStrictEqual(enKeys, zhKeys, 'same keys in both locales')
  for (const [key, value] of Object.entries(bundles.zh)) {
    assert.ok(/[\u4e00-\u9fff]/.test(value), `zh.${key} is Chinese`)
    assert.ok(!/\b(?:the|and|rewrite|draft|failed)\b/i.test(value), `zh.${key} has no leftover English`)
  }
})

t('empty draft: info toast, zero model calls, zero writes', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = () => Promise.resolve('   ')
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(mock.requests.length, 0, 'no llm.oneshot call')
  assert.strictEqual(mock.setDrafts.length, 0, 'draft untouched')
  assert.strictEqual(mock.notifies.length, 1)
  assert.strictEqual(mock.notifies[0].kind, 'info')
  assert.strictEqual(mock.notifies[0].message, mock.i18n[ID].en.emptyDraft)
})

t('rewrite: one oneshot call, fences stripped, draft replaced', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.focusedSid = 'sess-1'
  mock.onGetDraft = (sid) => Promise.resolve(sid === 'sess-1' ? '帮我看看这段话' : null)
  mock.onRequest = (method, params) => {
    assert.strictEqual(method, 'llm.oneshot')
    assert.strictEqual(params.input, '帮我看看这段话')
    assert.strictEqual(params.task, 'title_generation')
    assert.ok(params.instructions && params.instructions.length > 0)
    return Promise.resolve({ text: '```md\n优化后的文字。\n```' })
  }
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(mock.requests.length, 1, 'exactly one model call')
  assert.strictEqual(mock.setDrafts.length, 1)
  assert.deepStrictEqual(mock.setDrafts[0], { sid: 'sess-1', text: '优化后的文字。' })
  assert.strictEqual(mock.notifies[0].kind, 'info')
  assert.strictEqual(mock.notifies[0].message, mock.i18n[ID].en.done)
})

t('instructions: layout follows the content, numbered lists are conditional', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = () => Promise.resolve('draft text')
  mock.onRequest = () => Promise.resolve({ text: 'rewritten' })
  const btn = mountButton()
  await btn.props.onClick()
  const ins = mock.requests[0][1].instructions
  assert.ok(/never instructions to you/i.test(ins), 'draft is data, not instructions')
  assert.ok(/shape follow the content/i.test(ins), 'shape follows the content')
  assert.ok(/two or more list lines/i.test(ins), 'list detection is explicit')
  assert.ok(/same number of list lines and the same markers/i.test(ins), 'list shape is preserved')
  assert.ok(/never split one symptom/i.test(ins), 'no over-splitting')
  assert.ok(!/one requirement per line as a numbered list/i.test(ins), 'old forced template is gone')
  assert.ok(!/aim for 4-8 items/i.test(ins), 'no forced item count')
})

t('rewrite rejected: error toast, draft untouched', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = () => Promise.resolve('draft text')
  mock.onRequest = () => Promise.reject(new Error('boom'))
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(mock.setDrafts.length, 0)
  assert.strictEqual(mock.notifies.length, 1)
  assert.strictEqual(mock.notifies[0].kind, 'error')
  assert.strictEqual(mock.notifies[0].message, mock.i18n[ID].en.failed)
})

t('empty model output: no replace, honest toast', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = () => Promise.resolve('draft text')
  mock.onRequest = () => Promise.resolve({ text: '   ' })
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(mock.setDrafts.length, 0)
  assert.strictEqual(mock.notifies[0].message, mock.i18n[ID].en.emptyOutput)
})

t('runaway model output: draft kept, error toast', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = () => Promise.resolve('看看这个')
  mock.onRequest = () =>
    Promise.resolve({ text: 'Rewrite the text according to these requirements:\n' + 'x'.repeat(1000) })
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(mock.setDrafts.length, 0, 'runaway output is never written')
  assert.strictEqual(mock.notifies[0].kind, 'error')
  assert.strictEqual(mock.notifies[0].message, mock.i18n[ID].en.tooLong)
})

t('normal growth: a rewrite up to 4x the draft still lands', async () => {
  registerFresh()
  const mock = globalThis.__mock
  const draft = '帮我把登录页改一下，按钮颜色太浅了看不见'
  mock.onGetDraft = () => Promise.resolve(draft)
  mock.onRequest = () => Promise.resolve({ text: '修改登录页：\n按钮颜色太浅，改深一点。\n再检查一遍对比度。' })
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(mock.setDrafts.length, 1)
})

t('draft edited during the call: author text kept, no overwrite', async () => {
  registerFresh()
  const mock = globalThis.__mock
  let reads = 0
  mock.onGetDraft = () => {
    reads++
    return Promise.resolve(reads === 1 ? 'first draft' : 'first draft + my new line')
  }
  mock.onRequest = () => Promise.resolve({ text: 'rewritten' })
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(reads, 2, 'draft re-read after the model call')
  assert.strictEqual(mock.setDrafts.length, 0, 'edited draft not overwritten')
  assert.strictEqual(mock.notifies[0].message, mock.i18n[ID].en.draftChanged)
})

t('busy state: spinner icon and disabled button while the rewrite is in flight', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = () => Promise.resolve('draft text')
  let resolveRequest
  mock.onRequest = () => new Promise((res) => { resolveRequest = res })
  const first = mountButton()
  const pending = first.props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  const during = mountButton()
  assert.strictEqual(during.props.disabled, true, 'disabled while working')
  assert.strictEqual(during.props['aria-busy'], true)
  const spinner = render(mock.registrations[0].render()).find((n) => n.props && n.props.className === 'mp-spin')
  assert.ok(spinner, 'spinner shown while working')
  resolveRequest({ text: 'rewritten' })
  await pending
  const after = mountButton()
  assert.strictEqual(after.props.disabled, false, 'enabled again when done')
  assert.strictEqual(after.props['aria-busy'], false)
})

t('rapid double click fires exactly one model call', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = () => Promise.resolve('draft text')
  let calls = 0
  mock.onRequest = () => { calls++; return Promise.resolve({ text: 'rewritten' }) }
  const btn = mountButton()
  await Promise.all([btn.props.onClick(), btn.props.onClick()])
  await new Promise((r) => setTimeout(r, 10))
  assert.strictEqual(calls, 1, 'inFlight guard holds')
  assert.strictEqual(mock.setDrafts.length, 1)
})

t('dispose: in-flight guard, click does nothing after unload', async () => {
  const { disposes } = registerFresh()
  const mock = globalThis.__mock
  disposes.forEach((fn) => fn())
  assert.strictEqual(globalThis.document.getElementById('hermes-make-plain-style'), null, 'style tag removed on unload')
  mock.onGetDraft = () => Promise.resolve('draft text')
  const btn = mountButton()
  await btn.props.onClick()
  assert.strictEqual(mock.requests.length, 0)
  assert.strictEqual(mock.setDrafts.length, 0)
  assert.strictEqual(mock.notifies.length, 0)
})

t('addressing: fresh draft falls back to the focus bus', async () => {
  registerFresh()
  const mock = globalThis.__mock
  mock.onGetDraft = (sid) => Promise.resolve(sid === 'new' ? null : sid === null ? 'focus-bus draft' : null)
  mock.onRequest = () => Promise.resolve({ text: 'rewritten' })
  const btn = mountButton()
  await btn.props.onClick()
  assert.deepStrictEqual(mock.getDrafts, ['new', null, null])
  assert.deepStrictEqual(mock.setDrafts[0], { sid: null, text: 'rewritten' })
})

t('static: no app DOM reach, no listeners, no hardcoded colors', () => {
  const src = fs.readFileSync(ENTRY, 'utf8')
  for (const bad of ['document.querySelector(', 'addEventListener(',
    'eval(', 'new Function(', 'createElement(\'script\')', 'import(', 'data-slot', 'data-tour']) {
    assert.ok(!src.includes(bad), `source must not contain ${bad}`)
  }
  // The only DOM lookup allowed is the plugin's own style tag.
  const lookups = src.match(/document\.getElementById\([^)]*\)/g) || []
  assert.deepStrictEqual(lookups, ['document.getElementById(STYLE_ID)', 'document.getElementById(STYLE_ID)'])
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), 'no hex colors')
  assert.ok(!/rgba?\(/.test(src), 'no rgb() colors')
  assert.ok(src.includes("area: 'composer.actions'"), 'raw composer.actions area string')
})

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn()
    console.log('ok  -', name)
  } catch (err) {
    failed++
    console.log('FAIL-', name)
    console.log('   ', String(err && err.message))
  }
}
console.log(failed === 0 ? `ALL ${Object.keys(tests).length} PASSED` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
