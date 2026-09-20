import {
	runtime,
	nodeVersion,
	provider,
	isCI,
	isTest,
	isProduction,
	isDevelopment,
	platform,
} from 'std-env'
import type { PluxelPlatformSnapshot } from './platform'
/** Detect a small, non-secret snapshot suitable for logs and management clients. */
export function describePluxelPlatform(): PluxelPlatformSnapshot {
	return Object.freeze({
		runtime: Object.freeze({
			name: runtime || null,
			version: runtime === 'node' ? nodeVersion : null,
		}),
		deployment: Object.freeze({
			provider: provider || null,
			ci: isCI,
		}),
		mode: isTest ? 'test' : isProduction ? 'production' : isDevelopment ? 'development' : 'unknown',
		platform: platform || null,
	})
}
