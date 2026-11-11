import { useEffect, useState } from 'react'

/** Colour theme chosen in the header / login page / personal settings: light, follow the OS, or dark. Per device. */
export type ThemePref = 'light' | 'auto' | 'dark'
/** Personal text size (CSS zoom of the whole UI), per device. */
export type TextScale = 100 | 110 | 125

const KEY = 'kposs.theme'
const SCALE_KEY = 'kposs.text_scale'
const CHANGED = 'kposs:theme-changed'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

export function readTheme(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === 'dark' || v === 'auto' ? v : 'light'
}

export function readTextScale(): TextScale {
  const v = Number(localStorage.getItem(SCALE_KEY))
  return v === 110 || v === 125 ? v : 100
}

export function applyTheme(pref: ThemePref = readTheme()): void {
  const dark = pref === 'dark' || (pref === 'auto' && media().matches)
  document.documentElement.classList.toggle('dark', dark)
  const scale = readTextScale()
  document.documentElement.style.zoom = scale === 100 ? '' : `${scale}%`
}

/** Call once at startup: applies the stored theme and follows OS changes / other windows (CFD, KDS). */
export function initTheme(): void {
  applyTheme()
  media().addEventListener('change', () => applyTheme())
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === SCALE_KEY) {
      applyTheme()
      window.dispatchEvent(new Event(CHANGED))
    }
  })
}

function store(key: string, value: string) {
  localStorage.setItem(key, value)
  applyTheme()
  // every control showing the choice (header, login, personal settings) follows
  window.dispatchEvent(new Event(CHANGED))
}

function useStored<T>(read: () => T): T {
  const [v, setV] = useState<T>(read)
  useEffect(() => {
    const h = () => setV(read())
    window.addEventListener(CHANGED, h)
    return () => window.removeEventListener(CHANGED, h)
  }, [read])
  return v
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  return [useStored(readTheme), (p) => store(KEY, p)]
}

export function useTextScale(): [TextScale, (s: TextScale) => void] {
  return [useStored(readTextScale), (s) => store(SCALE_KEY, String(s))]
}

/** Whether the dark palette is showing right now (resolves "auto"). */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => o.disconnect()
  }, [])
  return dark
}
