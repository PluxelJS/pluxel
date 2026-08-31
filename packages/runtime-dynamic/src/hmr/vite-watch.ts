import { env } from '@pluxel/runtime/environment'

export const DEFAULT_VITE_WATCH_IGNORED = [
	/\.wrangler/,
	/\.mf/,
	/(^|[/\\])\.turbo([/\\]|$)/,
	/(^|[/\\])target([/\\]|$)/,
] as const

export const VITE_WATCH_USE_POLLING = ['1', 'true'].includes(
	env.CHOKIDAR_USEPOLLING?.toLowerCase() ?? '',
)
