import { fileURLToPath } from 'node:url'
import { compilePluxelParaglide } from '@pluxel/rolldown/vite/paraglide'

await compilePluxelParaglide(fileURLToPath(new URL('..', import.meta.url)))
