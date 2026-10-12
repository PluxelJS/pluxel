import { dirname, resolve } from 'node:path'
import { createHost, resolveHostApplication, prepareHostApplication } from '@pluxel/host'
import { createElysiaHandler } from '@pluxel/services/elysia'
import application from './application.ts'

/** The Electron carrier forwards Requests here; this Host never opens a listener. */
export async function startBackend(config: { root: string; assetsRoot: string }) {
	const resolved = await resolveHostApplication(application, {
		root: dirname(resolve(config.assetsRoot)),
		mode: 'production',
		env: process.env,
		bindings: config,
	})
	const host = await createHost({
		plugins: resolved.plugins,
		services: resolved.services,
		config: resolved.config,
		configRecords: resolved.configRecords,
		state: resolved.state,
		vaultBindings: resolved.vaultBindings,
	})
	try {
		await prepareHostApplication(resolved, host)
		const report = await host.start()
		if (
			report.reconciliation.length > 0 ||
			(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
		)
			throw new Error(`Studio failed to start: ${JSON.stringify(report)}`)
		return { fetch: createElysiaHandler(host), close: () => host.close() }
	} catch (error) {
		await host.close()
		throw error
	}
}
