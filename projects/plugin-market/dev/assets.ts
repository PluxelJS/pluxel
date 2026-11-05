import { resolve } from 'node:path'
import { projectRoot } from './session.ts'

export const marketAssets = {
	directory: resolve(projectRoot, 'dist/web'),
	hasUserWorker: true,
	notFoundHandling: 'none' as const,
	runWorkerFirst: ['/v1', '/v1/*', '/admin', '/admin/*'],
}
