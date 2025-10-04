import { Hono } from 'hono'
import type { AppEnv } from '../../hmr/src/services/hono/env'
import { App } from './app'
import { renderMiddleware } from './render'

const ssrApp = new Hono<AppEnv>()

ssrApp.use('*', (c, next) => renderMiddleware(c, next))

ssrApp.get('*', (c) => c.render(<App />))

export { ssrApp }
