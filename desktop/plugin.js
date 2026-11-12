/**
 * Hermes MakePlain — one-click composer polish for the Hermes Desktop chat.
 *
 * One button in the composer actions row (right side of the input, next to the
 * model pill). Clicking it reads the current draft through the official
 * host.composer draft API, rewrites it into a clearer version that keeps the
 * original meaning via a single stateless llm.oneshot call on the cheap auxiliary route
 * (task: title_generation), and replaces the draft in place. The message is
 * never sent, no app markup is touched, and nothing outlives the plugin: the
 * only teardown state is the disposed guard below.
 */

import { Button, host, Tip, usePluginI18n } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-make-plain'
const VERSION = '0.3.3'
// Auxiliary routing key: lands on the configured auxiliary.title_generation
// model (a cheap one), never the session's main model.
const ONESHOT_TASK = 'title_generation'
const ONESHOT_TIMEOUT_MS = 60000
const ONESHOT_MAX_TOKENS = 8192

const INSTRUCTIONS = [
  'Rewrite the text below into a request an AI can read and act on, and nothing else. Keep the original meaning exactly: add no facts and drop no facts. Return only the rewritten request.',
  '- Re-lay it out: start with one goal sentence on its own line, then one requirement per line as a numbered list. Group related facts into single items, keep only decisions and requirements, and aim for 4-8 items; never keep the draft\'s rambling paragraph shape.',
  '- Drop remarks about the conversation itself (\'as we discussed\', \'I thought about it again\') unless they decide something; the goal sentence says what to build, not what was chatted about.',
  '- Remove pure filler and verbal noise: opening interjections (\'hey\', \'so\', \'喂\', \'我跟你说一下\'), filler words (\'就是\', \'然后\', \'反正\', \'那个\', \'你也知道\', \'大概\'), false starts and repeated restatements. Say each point once.',
  '- Keep every fact, decision, name, number, date, version, port, path, file name, URL, @-reference, /command, code and constraint exactly as written, in the order it appears. Do not resolve an ambiguity, answer the request, or add advice.',
  '- Same language as the draft. Never translate.',
  '- Plain text: no headings above the goal, no code fence around the answer, no preamble or explanation.'
].join('\n')

// Unload guard: a rewrite already in flight must not touch the composer after
// the plugin is disabled or hot-replaced.
let disposed = false
// Double-click guard read imperatively: the render-closure busy flag is stale
// between two rapid clicks, so it must not gate anything.
let inFlight = false

const LOCALES = {
  en: {
    tip: 'Rewrite this draft so it reads clearly',
    working: 'Rewriting…',
    emptyDraft: 'The input box is empty. Write a draft first.',
    done: 'Draft replaced with the rewritten text.',
    emptyOutput: 'The model returned nothing; the draft is unchanged.',
    draftChanged: 'You edited the draft while it was rewriting, so your text was kept.',
    failed: 'Rewrite failed; the draft is unchanged.',
    replaceFailed: 'Rewritten, but writing it back to the input box failed.'
  },
  zh: {
    tip: '把草稿优化得更易读',
    working: '正在优化…',
    emptyDraft: '输入框还是空的，先写点草稿。',
    done: '已替换为整理后的文字。',
    emptyOutput: '模型没有返回内容，草稿保持原样。',
    draftChanged: '优化期间你改动了草稿，已保留你当前的内容。',
    failed: '优化失败，草稿保持原样。',
    replaceFailed: '优化完成，但写回输入框失败。'
  }
}

function WandIcon() {
  return jsxs('svg', {
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    children: [
      jsx('path', { d: 'M2.5 13.5 9 7' }),
      jsx('path', { d: 'M11.5 2.5v2.4M10.3 3.7h2.4' }),
      jsx('path', { d: 'M13 8.4v1.8M12.1 9.3h1.8' })
    ]
  })
}

// Working indicator: a rotating arc, so a click visibly responds while the
// rewrite is in flight. The keyframes live in the plugin's own style tag (no
// dependency on utility classes that may be missing from the app's build),
// removed again on unload.
const STYLE_ID = 'hermes-make-plain-style'
const STYLE_TEXT = '@keyframes mp-spin{to{transform:rotate(360deg)}}.mp-spin{animation:mp-spin .9s linear infinite;transform-origin:center}'

function ensureStyle() {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = STYLE_TEXT
}

function removeStyle() {
  const style = document.getElementById(STYLE_ID)
  if (style) style.remove()
}

function SpinnerIcon() {
  return jsxs('svg', {
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    className: 'mp-spin',
    'aria-hidden': 'true',
    children: [
      jsx('circle', { cx: 8, cy: 8, r: 5.5, opacity: 0.25 }),
      jsx('path', { d: 'M8 2.5A5.5 5.5 0 0 1 13.5 8' })
    ]
  })
}

// Models sometimes wrap the whole answer in a markdown fence even when asked
// not to; drop exactly that outer fence so the draft stays clean text.
function stripFences(text) {
  let out = String(text || '').trim()
  const m = out.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  if (m) out = m[1].trim()
  return out
}

// Addressing per the draft API: the focused session's composer when there is
// one, the fresh draft ('new') otherwise, with the focus bus as final fallback.
async function readDraft(addr) {
  let text = await host.composer.getDraft(addr)
  if (text == null) {
    const fallback = await host.composer.getDraft(null)
    if (fallback != null) return { addr: null, text: fallback }
  }
  return { addr, text }
}

function MakePlainButton() {
  const t = usePluginI18n(ID)
  const [busy, setBusy] = useState(false)

  async function run() {
    if (inFlight || disposed) return
    inFlight = true
    // Immediate visual response: the spinner shows from the first frame, before
    // the draft read or the model call.
    setBusy(true)
    try {
      let addr = host.state.focusedSessionId.get()
      if (addr == null) addr = 'new'
      let draft
      try {
        const read = await readDraft(addr)
        addr = read.addr
        draft = read.text
      } catch (err) {
        draft = null
      }
      if (disposed) return
      if (draft == null || !String(draft).trim()) {
        host.notify({ kind: 'info', message: t('emptyDraft') })
        return
      }
      try {
        const res = await host.request(
          'llm.oneshot',
          {
            instructions: INSTRUCTIONS,
            input: draft,
            task: ONESHOT_TASK,
            max_tokens: ONESHOT_MAX_TOKENS
          },
          ONESHOT_TIMEOUT_MS
        )
        const raw = typeof res === 'string' ? res : res && typeof res.text === 'string' ? res.text : ''
        const rewritten = stripFences(raw)
        if (disposed) return
        if (!rewritten) {
          host.notify({ kind: 'error', message: t('emptyOutput') })
          return
        }
        // The composer cannot be locked from a plugin (the SDK has no such
        // verb), so the author may have typed during the call. Their new text
        // wins: never overwrite a draft that changed under us.
        let current = null
        try {
          current = await host.composer.getDraft(addr)
        } catch (err) {
          current = null
        }
        if (disposed) return
        if (current != null && current !== draft) {
          host.notify({ kind: 'info', message: t('draftChanged') })
          return
        }
        const ok = await host.composer.setDraft(addr, rewritten)
        if (disposed) return
        host.notify({ kind: ok ? 'info' : 'error', message: ok ? t('done') : t('replaceFailed') })
      } catch (err) {
        if (!disposed) host.notify({ kind: 'error', message: t('failed') })
      }
    } finally {
      inFlight = false
      setBusy(false)
    }
  }

  return jsx(Tip, {
    label: busy ? t('working') : t('tip'),
    children: jsx(Button, {
      'aria-busy': busy,
      'aria-label': busy ? t('working') : t('tip'),
      disabled: busy,
      onClick: () => run(),
      size: 'icon',
      type: 'button',
      variant: 'ghost',
      children: busy ? jsx(SpinnerIcon, {}) : jsx(WandIcon, {})
    })
  })
}

export default {
  id: ID,
  name: 'Hermes MakePlain',
  register(ctx) {
    disposed = false
    if (ctx.i18n && typeof ctx.i18n.register === 'function') {
      ctx.i18n.register(LOCALES)
    }
    try {
      ensureStyle()
    } catch (err) {
      // No style tag means no spin animation; the button still works.
    }
    try {
      // Load evidence for offline verification (read back from the app's
      // Local Storage); a plain heartbeat, nothing else.
      ctx.storage.set('heartbeat', { at: Date.now(), version: VERSION })
    } catch (err) {
      // Storage is load evidence only; never let it break registration.
    }
    // Raw area string on purpose: the COMPOSER_AREAS named export was missing
    // in one packaged SDK build (ReferenceError at register time).
    ctx.register({
      id: 'button',
      area: 'composer.actions',
      render: () => jsx(MakePlainButton, {})
    })
    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        disposed = true
        removeStyle()
      })
    }
  }
}
