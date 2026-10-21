/// <reference types="vite/client" />
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'

/** Inter (variable, latin), self-hosted from the build: no font CDN. */
const inter = new FontFace('Inter Variable', `url(${interUrl}) format('woff2')`, { weight: '100 900', style: 'normal', display: 'swap' })
document.fonts.add(inter)
export const fontReady = inter.load().catch((e) => console.warn('Inter failed to load', e))
