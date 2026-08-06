import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { assertPluginLifecycleIssue, withRuntimeHost } from '@pluxel/runtime/test'
import { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } from '@pluxel/runtime-dynamic/hmr'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageManagerPlugin } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PackageManagerPlugin', () => {
	it('starts in a real dynamic host that declares its exact publication directory', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-dynamic-'))
		roots.push(root)
		await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n')
		await writeFile(
			resolve(root, 'pluxel.loader.hmr.jsonc'),
			JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		)
		const previousCwd = process.cwd()
		const managedRoot = resolve(root, '.pluxel/managed-plugins')
		const plan = await planLoaderHmrHostFromConfig({
			root,
			logging: false,
			printUrls: false,
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: { enabled: ['PackageManagerPlugin'] },
			},
			plugins: [PackageManagerPlugin],
			sources: [
				{
					kind: 'directory',
					path: '.pluxel/managed-plugins/entries',
					include: ['*.mjs'],
				},
			],
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			await host.hmr.start()
			expect(host.ctx.registry.isRunning(PackageManagerPlugin)).toBe(true)
			expect(existsSync(resolve(managedRoot, 'entries'))).toBe(true)
			expect(host.ctx.commands.get('package.install')).toBeDefined()
			const instance = host.ctx.registry.getInstance(PackageManagerPlugin)
			expect(instance).toBeDefined()
			await expect(instance!.snapshot()).resolves.toMatchObject({
				rootDir: managedRoot,
				packages: [],
			})
		} finally {
			await host.stop()
			process.chdir(previousCwd)
		}
	}, 60_000)

	it('fails before filesystem or command side effects outside a declared dynamic source', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-plugin-'))
		roots.push(root)
		const managedRoot = resolve(root, 'managed')

		await withRuntimeHost(
			async (host) => {
				host.add(PackageManagerPlugin)
				host.cfg(PackageManagerPlugin).set({
					config: {
						rootDir: managedRoot,
						ignoreScripts: true,
						allowBuilds: [],
						minimumReleaseAgeMinutes: 0,
					},
				})
				host.cfg(PackageManagerPlugin).enable()
				const summary = await host.commitAllowFail()

				assertPluginLifecycleIssue(summary, PackageManagerPlugin, {
					kind: 'start-failed',
					message: 'dynamic runtime host',
				})
				expect(host.isRunning(PackageManagerPlugin)).toBe(false)
				expect(existsSync(managedRoot)).toBe(false)
				expect(host.ctx.commands.get('package.install')).toBeUndefined()
				expect(host.ctx.commands.get('package.remove')).toBeUndefined()
			},
			{ workbench: false },
		)
	})

	it.each([
		['directory', '/different/entries', ['*.mjs']],
		['include', null, ['*.js']],
		['include-extra', null, ['*.mjs', '*.js']],
	] as const)(
		'fails before side effects when the declared source has a %s mismatch',
		async (_kind, declaredPath, declaredInclude) => {
			const root = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-mismatch-'))
			roots.push(root)
			const managedRoot = resolve(root, 'managed')

			await withRuntimeHost(
				async (host) => {
					type TestContext = {
						runtimeRoute?: {
							dynamicPluginSources?: {
								hasFile(path: string): boolean
								hasDirectory(path: string, include: readonly string[]): boolean
							}
						}
					}
					const ctx = host.ctx as unknown as TestContext
					ctx.runtimeRoute = {
						dynamicPluginSources: {
							hasFile: () => false,
							hasDirectory: (path, include) => {
								const declared = new Set<string>(declaredInclude)
								const required = new Set(include)
								return (
									path === (declaredPath ?? resolve(managedRoot, 'entries')) &&
									declared.size === required.size &&
									[...required].every((pattern) => declared.has(pattern))
								)
							},
						},
					}
					host.add(PackageManagerPlugin)
					host.cfg(PackageManagerPlugin).set({
						config: {
							rootDir: managedRoot,
							ignoreScripts: true,
							allowBuilds: [],
							minimumReleaseAgeMinutes: 0,
						},
					})
					host.cfg(PackageManagerPlugin).enable()
					const summary = await host.commitAllowFail()

					assertPluginLifecycleIssue(summary, PackageManagerPlugin, {
						kind: 'start-failed',
						message: 'not declared',
					})
					expect(existsSync(managedRoot)).toBe(false)
					expect(host.ctx.commands.get('package.install')).toBeUndefined()
				},
				{ workbench: false },
			)
		},
	)
})
