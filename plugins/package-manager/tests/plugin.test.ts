import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost, defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { commands } from '@pluxel/services/commands'
import { pluginSource } from '@pluxel/host/sources'
import { installPluginSources } from '@pluxel/host/internal'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageManagerConfig, PackageManagerPlugin } from '../src/index.ts'

const roots: string[] = []

let headlessRoot = ''
@Plugin()
class HeadlessPackageConsumer extends BasePlugin {
	constructor(private readonly packages: PackageManagerPlugin) {
		super()
	}
	async init() {
		expect(this.ctx.workbench).toBeUndefined()
		expect(await this.packages.snapshot()).toMatchObject({ rootDir: headlessRoot, packages: [] })
		const rejected = await this.packages.install(['https://example.invalid/plugin.tgz'])
		expect(rejected.ok).toBe(false)
		expect(rejected.failed[0]?.code).toBe('INVALID_SPEC')
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PackageManagerPlugin', () => {
	it('accepts env-bound deployment configuration without Workbench or installation-state overrides', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-headless-'))
		roots.push(root)
		headlessRoot = resolve(root, 'managed')
		const application = defineHostApplication(() => ({
			plugins: [PackageManagerPlugin, HeadlessPackageConsumer],
			services: [commands()],
			state: { initial: { autoStart: [pluginNodeAddressOf(HeadlessPackageConsumer)] } },
			envBindings: [
				envBinding(PackageManagerPlugin, {
					config: {
						schema: PackageManagerConfig,
						mapping: { rootDir: 'MANAGED_ROOT', minimumReleaseAgeMinutes: 'MINIMUM_RELEASE_AGE' },
					},
				}),
			],
		}))
		const resolved = await resolveHostApplication(application, {
			root,
			mode: 'test',
			bindings: {},
			env: { MANAGED_ROOT: headlessRoot, MINIMUM_RELEASE_AGE: '0' },
		})
		const host = await createHost({
			plugins: resolved.plugins,
			services: resolved.services,
			state: resolved.state,
			config: resolved.config,
			configRecords: resolved.configRecords,
		})
		try {
			// This file tests Host source integration: native/Vite loaders install the same declaration.
			installPluginSources(host.ctx, {
				updates: 'next-start',
				root,
				sources: [
					pluginSource({
						kind: 'directory',
						path: resolve(headlessRoot, 'entries'),
						include: ['*.mjs'],
					}),
				],
			})
			await host.start()
			const status = await host.status()
			expect(status.summary.running).toBe(2)
			expect(existsSync(resolve(headlessRoot, 'entries'))).toBe(true)
		} finally {
			await host.close()
		}
		expect(existsSync(resolve(headlessRoot, '.writer'))).toBe(false)
	})
	it.each([undefined, '*.js'])('validates source %s before producer effects', async (include) => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-plugin-'))
		roots.push(root)
		const managedRoot = resolve(root, 'managed')

		{
			await using host = await createServiceInternalTestHost()
			if (include)
				installPluginSources(host.ctx, {
					updates: 'live',
					root,
					sources: [
						pluginSource({
							kind: 'directory',
							path: resolve(managedRoot, 'entries'),
							include: [include],
						}),
					],
				})

			const failure = await host.commitExpectFail((change) => {
				change.start(PackageManagerPlugin, {
					initialConfig: {
						rootDir: managedRoot,
						ignoreScripts: true,
						allowBuilds: [],
						minimumReleaseAgeMinutes: 0,
					},
				})
			})

			expect(failure.lifecycleReport.issues).toContainEqual(
				expect.objectContaining({
					plugin: pluginNodeAddressOf(PackageManagerPlugin),
					kind: 'start-failed',
					message: expect.stringMatching(/Plugin source|Plugin sources/),
				}),
			)
			expect(host.isRunning(PackageManagerPlugin)).toBe(false)
			expect(existsSync(managedRoot)).toBe(false)
			expect(host.commands.list().some(({ name }) => name === 'package.install')).toBe(false)
			expect(host.commands.list().some(({ name }) => name === 'package.remove')).toBe(false)
		}
	})
	it('starts the producer after declaration coverage is installed', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-plugin-'))
		roots.push(root)
		const managedRoot = resolve(root, 'managed')
		await using host = await createServiceInternalTestHost()
		installPluginSources(host.ctx, {
			updates: 'live',
			root,
			sources: [
				pluginSource({
					kind: 'directory',
					path: resolve(managedRoot, 'entries'),
					include: ['*.mjs'],
				}),
			],
		})
		await host.start(PackageManagerPlugin, {
			initialConfig: { rootDir: managedRoot, minimumReleaseAgeMinutes: 0 },
		})
		expect(existsSync(resolve(managedRoot, 'entries'))).toBe(true)
		expect(host.commands.list().some(({ name }) => name === 'package.install')).toBe(true)
		await expect(host.commands.execute('package.install', { specs: [] })).resolves.toMatchObject({
			status: 'error',
			error: { code: 'INPUT_VALIDATION', issues: expect.any(Array) },
		})
	})
})
