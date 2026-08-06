import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { withRuntimeHost } from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageManagerPlugin } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PackageManagerPlugin', () => {
	it('provides headless commands without installing the Workbench plane', async () => {
		const rootDir = await mkdtemp(resolve(tmpdir(), 'pluxel-package-manager-plugin-'))
		roots.push(rootDir)

		await withRuntimeHost(
			async (host) => {
				host.add(PackageManagerPlugin)
				host.cfg(PackageManagerPlugin).set({
					config: {
						rootDir,
						ignoreScripts: true,
						allowBuilds: [],
						minimumReleaseAgeMinutes: 0,
					},
				})
				host.cfg(PackageManagerPlugin).enable()
				await host.commit()

				expect(host.isRunning(PackageManagerPlugin)).toBe(true)
				expect(host.ctx.commands.get('package.install')).toBeDefined()
				expect(host.ctx.commands.get('package.remove')).toBeDefined()
				await expect(host.require(PackageManagerPlugin).snapshot()).resolves.toMatchObject({
					rootDir,
					packages: [],
				})
				await expect(
					host.ctx.commands.executeOrThrow('package.install', { specs: ['../local'] }),
				).resolves.toMatchObject({
					ok: false,
					failed: [{ code: 'INVALID_SPEC' }],
				})

				host.remove(PackageManagerPlugin)
				await host.commit()
				expect(host.ctx.commands.get('package.install')).toBeUndefined()
				expect(host.ctx.commands.get('package.remove')).toBeUndefined()
			},
			{ workbench: false },
		)
	})
})
