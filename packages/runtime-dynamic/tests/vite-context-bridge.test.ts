import { execFile } from 'node:child_process'
import { mkdir, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'
import { normalizePath, type Plugin } from 'vite'

import { dynamicRuntimeVitePlugin } from '../src/vite'

const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(import.meta.dirname, '../../..')
const runtimeDynamicRoot = resolve(workspaceRoot, 'packages/runtime-dynamic')
const runnerScript = resolve(import.meta.dirname, 'support/vite-context-bridge-runner.mts')
const contextPackageRoot = resolve(workspaceRoot, 'packages/context')
const corePackageRoot = resolve(workspaceRoot, 'packages/core')
const runtimePackageRoot = resolve(workspaceRoot, 'packages/runtime')
const elysiaPackageRoot = resolve(runtimeDynamicRoot, 'node_modules/elysia')
const contextSource = normalizePath(resolve(contextPackageRoot, 'src/index.ts'))
const contextInternalSource = normalizePath(resolve(contextPackageRoot, 'src/internal.ts'))
const coreSource = normalizePath(resolve(corePackageRoot, 'src/index.ts'))
const coreInternalSource = normalizePath(resolve(corePackageRoot, 'src/internal.ts'))

describe('dynamic config host singleton bridge', () => {
	it('externalizes bare, internal and workspace source imports to the same ESM host entries', async () => {
		await using fixture = await createDiskFixture({
			'package.json': JSON.stringify({ name: '@fixture/dynamic-context-bridge', private: true }),
			'entry.ts': [
				"import * as core from '@pluxel/core'",
				"import * as coreInternal from '@pluxel/core/internal'",
				"import * as context from '@pluxel/context'",
				"import * as contextInternal from '@pluxel/context/internal'",
				`import * as coreSource from ${JSON.stringify(`/@fs/${coreSource}`)}`,
				`import * as coreInternalSource from ${JSON.stringify(`/@fs/${coreInternalSource}`)}`,
				`import * as contextSource from ${JSON.stringify(`/@fs/${contextSource}`)}`,
				`import * as contextInternalSource from ${JSON.stringify(`/@fs/${contextInternalSource}`)}`,
				'export { core, coreInternal, coreSource, coreInternalSource, context, contextInternal, contextSource, contextInternalSource }',
				'',
			].join('\n'),
			'plugin/package.json': JSON.stringify({
				name: '@fixture/elysia-plugin',
				private: true,
				dependencies: { elysia: '2.0.0-beta.7' },
			}),
			'plugin/entry.ts': [
				"import * as elysia from 'elysia'",
				"import * as websocket from 'elysia/websocket'",
				'export { elysia, websocket }',
				'',
			].join('\n'),
		})
		await mkdir(fixture.getPath('node_modules/@pluxel'), { recursive: true })
		await mkdir(fixture.getPath('plugin/node_modules'), { recursive: true })
		await symlink(contextPackageRoot, fixture.getPath('node_modules/@pluxel/context'), 'dir')
		await symlink(corePackageRoot, fixture.getPath('node_modules/@pluxel/core'), 'dir')
		await symlink(runtimePackageRoot, fixture.getPath('node_modules/@pluxel/runtime'), 'dir')
		await symlink(elysiaPackageRoot, fixture.getPath('plugin/node_modules/elysia'), 'dir')

		await expect(
			execFileAsync(process.execPath, ['--import', 'tsx', runnerScript], {
				cwd: runtimeDynamicRoot,
				env: {
					...process.env,
					PLUXEL_CONTEXT_BRIDGE_FIXTURE: fixture.path,
					PLUXEL_CONTEXT_PACKAGE_ROOT: contextPackageRoot,
				},
				timeout: 60_000,
			}),
		).resolves.toBeDefined()
	}, 90_000)

	it('does not require standalone Context when the host has not installed it', async () => {
		await using fixture = await createDiskFixture({
			'package.json': JSON.stringify({ name: '@fixture/without-context', private: true }),
			'entry.ts': 'export {}\n',
		})
		const bridge = singletonBridgePlugin()
		const configResolved = bridge.configResolved as (config: { root: string }) => void
		configResolved({ root: fixture.path })
		const resolveId = bridge.resolveId as (
			id: string,
			importer: string,
			options: { ssr: boolean },
		) => unknown

		expect(() =>
			resolveId('@pluxel/context', fixture.getPath('entry.ts'), { ssr: true }),
		).not.toThrow()
		expect(resolveId('@pluxel/context', fixture.getPath('entry.ts'), { ssr: true })).toBeNull()
		expect(
			resolveId('@pluxel/context/internal', fixture.getPath('entry.ts'), { ssr: true }),
		).toBeNull()
	})

	it('bridges every host-exported Elysia subpath without accepting private dist paths', () => {
		const bridge = singletonBridgePlugin()
		const bridgeConfig = (
			bridge.config as () => {
				resolve?: { dedupe?: string[] }
				ssr?: { external?: string[] }
			}
		)()
		expect(bridgeConfig.resolve?.dedupe).toContain('elysia')
		expect(bridgeConfig.ssr?.external).toEqual(
			expect.arrayContaining(['@pluxel/context', '@pluxel/core', '@pluxel/runtime']),
		)
		expect(bridgeConfig.ssr?.external).not.toContain('elysia')
		const configResolved = bridge.configResolved as (config: { root: string }) => void
		configResolved({ root: runtimeDynamicRoot })
		const resolveId = bridge.resolveId as (
			id: string,
			importer: string,
			options: { ssr: boolean },
		) => unknown
		const importer = resolve(runtimeDynamicRoot, 'src/vite.ts')

		for (const specifier of ['elysia', 'elysia/websocket', 'elysia/type']) {
			expect(resolveId(specifier, importer, { ssr: true })).toMatchObject({
				external: true,
				id: expect.stringMatching(/^file:.*\/elysia\/dist\//),
			})
		}
		expect(resolveId('elysia/package.json', importer, { ssr: true })).toBeNull()
		expect(resolveId('elysia/dist/private', importer, { ssr: true })).toBeNull()
	})
})

function singletonBridgePlugin(): Plugin {
	const plugin = (dynamicRuntimeVitePlugin({ config: './unused.ts' }) as Plugin[]).find(
		(candidate) => candidate.name === 'pluxel:dynamic-singleton-bridge',
	)
	if (!plugin) throw new Error('dynamic singleton bridge plugin is missing')
	return plugin
}
