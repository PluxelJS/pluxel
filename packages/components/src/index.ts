export * from './AutoForm'
export * from './DebugValues'
export * from './renders'
export * from './main'

export * as v from 'valibot'
export * as f from 'valibot-form'

import { hc } from 'hono/client'
import type { AppType } from '../../hmr/src/services/hono'
export const api = hc<AppType>('/api')
