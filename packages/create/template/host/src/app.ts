import * as nativeFs from 'node:fs'
import { defineHostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { listenElysia } from '@pluxel/services/elysia/node'
import { Passthrough } from '@pluxel/core/fs'
import { VaultAdminPlugin } from '@pluxel/services/plugins'
import { AuditPlugin } from '@example/audit-plugin'
import { HttpPlugin } from '@example/http-plugin'
import { TodoPlugin } from '@example/todo-plugin'
import { resolve } from 'node:path'
import { product } from './product'

export { product }

export default defineHostApplication(async (startup) => {
	const environment = resolveHostEnv(startup.env)
	const dataRoot = resolve(startup.deployment?.root ?? startup.root, environment.dataRoot)
	const { env } = startup
	const prefix = resolve(dataRoot, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'pluxel-example',
		config: { mode: 'saved-first' },
		policy: { mode: 'saved-first' },
		plugins: [
			{ plugin: AuditPlugin, autoStart: true },
			{
				plugin: TodoPlugin,
				config: {
					maxItems:
						env.EXAMPLE_TODO_MAX_ITEMS === undefined ? 12 : Number(env.EXAMPLE_TODO_MAX_ITEMS),
					seedTitle: 'Trace a Todo from React to a Plugin',
				},
			},
			{ plugin: HttpPlugin, autoStart: true },
			{ plugin: VaultAdminPlugin, autoStart: true },
		],
		sources: [
			{
				directory: resolve(dataRoot, 'managed-plugins/entries'),
				include: ['*.mjs'],
			},
		],
		services: await servicesPreset(startup, {
			product,
			workbench:
				(environment.workbench ?? startup.deployment?.variant !== 'headless') ? undefined : false,
		}),
		async launch({ host }) {
			await listenElysia(host, {
				hostname: environment.hostBind,
				port: environment.hostPort,
				publicOrigin: environment.publicOrigin,
				publicDir: resolve(startup.deployment?.root ?? startup.root, 'public'),
			})
		},
		coreConfig: {
			vault: { deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY },
			logtape: {},
			zenfs: {
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			},
		},
	}
})
