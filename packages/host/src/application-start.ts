import type { PluginApplyReport } from './coordinator'
import type { PluginHost } from './host'
import type { HostPluginStatusOverview } from './status'
import type { HostStartupContext, ResolvedHostApplication } from './application'

/** Settled startup facts. This snapshot is not a continuing health guarantee. */
export type HostApplicationStartup = Readonly<{
	host: PluginHost
	startup: HostStartupContext
	report: PluginApplyReport
	status: HostPluginStatusOverview
}>

/** The application did not accept its settled startup; its Host has been closed before rejection. */
export class HostApplicationStartupError extends Error {
	readonly code = 'startup_rejected' as const
	constructor(
		readonly report: PluginApplyReport,
		readonly status: HostPluginStatusOverview,
	) {
		const unavailable = status.statuses.filter(
			(node) => node.desiredState === 'running' && node.lifecycleState !== 'running',
		)
		super(
			'[host] Application startup rejected' +
				(unavailable.length > 0
					? ': ' +
						unavailable
							.map(
								(node) =>
									`${node.displayName}: ${node.issues.map((issue) => issue.message).join('; ') || 'not running'}`,
							)
							.join('; ')
					: ' by the application'),
		)
		this.name = 'HostApplicationStartupError'
	}
}

/** The caller owns rollback and invokes this after attachments are ready and before Plugin admission. */
export async function prepareHostApplication(
	application: ResolvedHostApplication,
	host: PluginHost,
): Promise<void> {
	await application.prepare?.({ host, startup: application.startup })
}

/** @internal Run once for a fresh, attached Host. Native and bundled launchers share this boundary. */
export async function startHostApplication(
	application: ResolvedHostApplication,
	host: PluginHost,
): Promise<PluginApplyReport> {
	try {
		await prepareHostApplication(application, host)
		const report = await host.start()
		const status = await host.status()
		const accepted = application.acceptStartup
			? await application.acceptStartup({ host, startup: application.startup, report, status })
			: status.statuses.every(
					(node) => node.desiredState !== 'running' || node.lifecycleState === 'running',
				)
		if (typeof accepted !== 'boolean')
			throw new TypeError('[host] Application acceptStartup must return a boolean')
		if (!accepted) throw new HostApplicationStartupError(report, status)
		await application.launch?.({ host, startup: application.startup })
		return report
	} catch (error) {
		const [cleanup] = await Promise.allSettled([host.close()])
		if (
			cleanup.status === 'rejected' &&
			error !== cleanup.reason &&
			!(error instanceof AggregateError && error.errors.includes(cleanup.reason))
		)
			throw new AggregateError(
				[error, cleanup.reason],
				'[host] Application startup and cleanup failed',
				{
					cause: error,
				},
			)
		throw error
	}
}
