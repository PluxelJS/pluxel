import { BasePlugin, Plugin } from '@pluxel/core/test'
import { pluginNodeAddressOf } from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import type { HostApplication } from '../src/host'
import { bindConfigEnvironment } from '../src/config-environment'
import { resolveHostApplication, runHostApplication } from '../src/application'
import { createDocumentStorage } from './helpers/document-storage'

const Config = v.object({ enabled: v.boolean(), limit: v.number() })
@Plugin()
export class Configured extends BasePlugin {
	readonly config = this.configs.use(Config)
}

const startup = { root: process.cwd(), mode: 'test' as const, bindings: {}, env: {} }
const address = () => pluginNodeAddressOf(Configured)

it('decodes the exact Plugin schema and gives the structured environment snapshot final seed precedence', async () => {
	const owner = address()
	const application = {
		plugins: [Configured],
		configRecords: { initial: [{ owner, config: { limit: 1 } }] },
		configEnvironmentBootstrap: [
			bindConfigEnvironment(Configured, Config, { enabled: 'APP_ENABLED', limit: 'APP_LIMIT' }),
		],
	}
	const resolved = await resolveHostApplication(application, {
		...startup,
		env: {
			APP_ENABLED: 'true',
			APP_LIMIT: '12',
			PLUXEL_CONFIG: JSON.stringify({ version: 3, plugins: [{ owner, config: { limit: 20 } }] }),
		},
	})
	expect(resolved.configRecords?.initial).toEqual([{ owner, config: { enabled: true, limit: 20 } }])
	expect(application.configRecords.initial[0]?.config).toEqual({ limit: 1 })
	await expect(
		resolveHostApplication(application, { ...startup, env: { APP_LIMIT: 'oops' } }),
	).rejects.toThrow(/APP_LIMIT/)
	await expect(
		resolveHostApplication(
			{ plugins: [], configEnvironmentBootstrap: application.configEnvironmentBootstrap },
			startup,
		),
	).rejects.toThrow('outside the static application catalog')
})

it('keeps persisted documents authoritative over later environment seeds', async () => {
	const owner = address()
	const storage = createDocumentStorage()
	const application: HostApplication = { plugins: [], configRecords: { storage } }
	const boot = (limit: number) =>
		runHostApplication(application, {
			startup: {
				...startup,
				env: {
					PLUXEL_CONFIG: JSON.stringify({ version: 3, plugins: [{ owner, config: { limit } }] }),
				},
			},
		})
	const first = await boot(12)
	expect(requireConfigService(first.ctx).getRawConfig(owner)).toEqual({ limit: 12 })
	await first.close()
	const second = await boot(99)
	try {
		expect(requireConfigService(second.ctx).getRawConfig(owner)).toEqual({ limit: 12 })
	} finally {
		await second.close()
	}
})

it('rejects malformed snapshots before preparing services', async () => {
	await expect(
		resolveHostApplication(
			{ plugins: [] },
			{ ...startup, env: { PLUXEL_CONFIG: '{"version":1,"plugins":[]}' } },
		),
	).rejects.toThrow('config snapshot version 3')
})
