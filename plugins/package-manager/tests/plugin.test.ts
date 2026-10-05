import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pluginNodeAddressOf } from '@pluxel/core'
import { pluginSource } from '@pluxel/host/sources'
import { installPluginSources } from '@pluxel/host/internal'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageManagerPlugin } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PackageManagerPlugin', () => {
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
