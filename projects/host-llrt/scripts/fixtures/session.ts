import {
	inspectHost,
	probeEnvironment,
	probePlugins,
} from '@pluxel-example/host-targets-plugins/probe'
import { snapshotWorkerCoreFacilitiesConfig } from '@pluxel/core/internal'
import { createScriptScope } from '../../../../packages/host/src/agent/sdk'
import { startEmbeddedApplication } from '../../../../packages/host/src/embedded-application'

export async function run(sourceUrl: string) {
	await using host = await startEmbeddedApplication(
		() => ({ plugins: probePlugins(sourceUrl) }),
		snapshotWorkerCoreFacilitiesConfig,
		{ env: probeEnvironment },
	)
	await using scope = createScriptScope({ ctx: host.ctx })
	return JSON.stringify(
		await inspectHost(scope.sdk, {
			sourceUrl,
			expectedSource: 'Rust loopback',
			sessionFiles: 'ENOTSUP',
		}),
	)
}
