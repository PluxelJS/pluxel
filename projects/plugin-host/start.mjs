import { runHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { serviceSharedPackages } from '@pluxel/services/sources'
import { fileURLToPath } from 'node:url'

const startupEnv = Object.freeze({ ...process.env })
const environment = resolveHostEnv(startupEnv)
const host = await runHostApplication(fileURLToPath(new URL('./dist/app.mjs', import.meta.url)), {
	startup: { root: import.meta.dirname, mode: 'production', env: startupEnv, bindings: {} },
	sharedPackages: serviceSharedPackages,
})
let listener
try {
	const { listenElysia } = await import('@pluxel/services/elysia/node')
	listener = await listenElysia(host, {
		hostname: environment.hostBind,
		port: environment.hostPort,
		publicOrigin: environment.publicOrigin,
		publicDir: fileURLToPath(new URL('./dist/public', import.meta.url)),
	})
} catch (error) {
	const [cleanup] = await Promise.allSettled([host.close()])
	if (cleanup.status === 'rejected')
		throw new AggregateError(
			[error, cleanup.reason],
			'Application listener startup and cleanup failed',
			{ cause: error },
		)
	throw error
}
const { createElysiaHandler } = await import('@pluxel/services/elysia')
export const address = listener.address
export const fetch = createElysiaHandler(host)
export const stop = listener.close
