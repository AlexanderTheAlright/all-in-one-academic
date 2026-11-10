import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { api } from './lib/api'
import { installLane, laneBase } from './lib/lane'
import { installNetCache } from './lib/netcache'
import { startPrefetch } from './lib/prefetch'
import { noteBundleUpdate } from './lib/boardcache'
import App from './App.tsx'

installLane()

if (navigator.webdriver) {
  const w = window as unknown as Record<string, unknown>
  w.__aioaApi = api
  w.__aioaLaneBase = laneBase
}

installNetCache()

function loadBrandFonts() {
  const add = (attrs: Record<string, string>) => {
    const l = document.createElement('link')
    for (const [k, v] of Object.entries(attrs)) l.setAttribute(k, v)
    document.head.appendChild(l)
  }
  add({ rel: 'preconnect', href: 'https://fonts.googleapis.com' })
  add({ rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' })
  add({ rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=Geist:wght@400;500;600&display=swap' })
}
fetch('/surface').then((r) => r.json()).then((s) => { if (s && s.webFonts) loadBrandFonts() }).catch(() => {})

function currentView(): string | undefined {
  try {
    const m = /^\/v\/([a-z-]+)/.exec(location.pathname)
    if (m) return m[1]
    if (location.pathname.startsWith('/w/')) return undefined      // a widget window is not a view
    const h = location.hash.replace(/^#\/?/, '').split('/')[0].toLowerCase()
    if (h) return h
    const raw = localStorage.getItem('aioa-route')
    if (raw) return (JSON.parse(raw) as { view?: string }).view
  } catch { /* privacy mode, bad JSON */ }
  return undefined
}

function registerWorker() {
  try {
    const proto = location.protocol
    if (proto !== 'http:' && proto !== 'https:') return
    if (!('serviceWorker' in navigator)) return
    const optIn = new URLSearchParams(location.search).get('sw') === '1'
    if (navigator.webdriver && !optIn) return
    const swPath = '/' + ['sw', 'js'].join('.')
    navigator.serviceWorker.register(swPath).catch(() => { /* not served: no cache tier */ })
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      if (e.data && e.data.type === 'all_in_one_academic-bundle-updated') noteBundleUpdate()
    })
  } catch { /* no SW support */ }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// after the first paint: register the worker, then walk every other view at idle
requestAnimationFrame(() => requestAnimationFrame(() => {
  registerWorker()
  let optIn = false
  try {
    const q = new URLSearchParams(location.search)
    optIn = q.get('prefetch') === '1' || q.get('sw') === '1'
  } catch { /* no search */ }
  if (!navigator.webdriver || optIn) setTimeout(() => startPrefetch(currentView()), 250)
}))
