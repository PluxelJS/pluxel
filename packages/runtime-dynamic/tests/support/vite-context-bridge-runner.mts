import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createServer, type Plugin } from 'vite'

import { importViteSsrModule } from '../../../runtime-dev/src/vite.ts'
import { dynamicRuntimeVitePlugin } from '../../src/vite.ts'
import { LOADER_HMR_OPTIONAL_BRIDGE_MODULES } from '../../src/hmr/engine/config.ts'
import { HmrEnvironment } from '../../src/hmr/engine/environment.ts'
import { HmrRunner } from '../../src/hmr/engine/runner.ts'

const fixtureRoot = process.env.PLUXEL_CONTEXT_BRIDGE_FIXTURE
const contextPackageRoot = process.env.PLUXEL_CONTEXT_PACKAGE_ROOT
if (!fixtureRoot || !contextPackageRoot)
	throw new Error('Context bridge fixture environment is missing')

const dynamicPlugins = dynamicRuntimeVitePlugin({ entry: './unused.ts' }) as Plugin[]
const bridge = dynamicPlugins.find((plugin) => plugin.name === 'pluxel:dynamic-singleton-bridge')
if (!bridge) throw new Error('dynamic singleton bridge plugin is missing')

const server = await createServer({
	root: fixtureRoot,
	appType: 'custom',
	plugins: [bridge],
	server: {
		hmr: false,
		middlewareMode: true,
		watch: null,
		ws: false,
	},
})

try {
	const importer = resolve(fixtureRoot, 'entry.ts')
	const fetchedCore = (await server.environments.ssr.fetchModule('@pluxel/core', importer)) as {
		externalize?: string
	}
	const fetchedContext = (await server.environments.ssr.fetchModule(
		'@pluxel/context',
		importer,
	)) as { externalize?: string }
	const pluginImporter = resolve(fixtureRoot, 'plugin/entry.ts')
	assert.equal(fetchedCore.externalize, import.meta.resolve('@pluxel/core'))
	assert.equal(
		fetchedContext.externalize,
		pathToFileURL(resolve(contextPackageRoot, 'dist/index.mjs')).href,
	)

	const hostCore = await import('@pluxel/core')
	const hostCoreInternal = await import('@pluxel/core/internal')
	const hostContext = await import(
		pathToFileURL(resolve(contextPackageRoot, 'dist/index.mjs')).href
	)
	const hostContextInternal = await import(
		pathToFileURL(resolve(contextPackageRoot, 'dist/internal.mjs')).href
	)
	const loaded = await importViteSsrModule<Record<string, Record<string, unknown>>>(
		server,
		importer,
	)
	const loadedPlugin = await importViteSsrModule<Record<string, Record<string, unknown>>>(
		server,
		pluginImporter,
	)
	const hostElysia = await import('elysia')
	const hostWebSocket = await import('elysia/websocket')

	assert.equal(loaded.core.BasePlugin, hostCore.BasePlugin)
	assert.equal(loaded.coreSource.BasePlugin, hostCore.BasePlugin)
	assert.equal(
		loaded.coreInternal.consumePluginDefinitionCandidate,
		hostCoreInternal.consumePluginDefinitionCandidate,
	)
	assert.equal(
		loaded.coreInternalSource.consumePluginDefinitionCandidate,
		hostCoreInternal.consumePluginDefinitionCandidate,
	)
	assert.equal(loaded.context.createContextHost, hostContext.createContextHost)
	assert.equal(loaded.contextSource.createContextHost, hostContext.createContextHost)
	assert.equal(loaded.contextInternal.createRootContext, hostContextInternal.createRootContext)
	assert.equal(
		loaded.contextInternalSource.createRootContext,
		hostContextInternal.createRootContext,
	)
	assert.equal(loadedPlugin.elysia.Elysia, hostElysia.Elysia)
	assert.equal(loadedPlugin.websocket.websocket, hostWebSocket.websocket)

	const bridgeSpecifiers = [
		'@pluxel/core',
		'@pluxel/core/internal',
		'@pluxel/context',
		'@pluxel/context/internal',
	] as const
	const environment = new HmrEnvironment({
		cwd: fixtureRoot,
		scanRootsAbs: [fixtureRoot],
	})
	environment.setServerRoot(fixtureRoot)
	const runner = new HmrRunner()
	runner.init(server, {
		hostCwd: fixtureRoot,
		bridgeModules: bridgeSpecifiers,
		optionalBridgeModules: LOADER_HMR_OPTIONAL_BRIDGE_MODULES,
	})
	await runner.bridgeHostModules(bridgeSpecifiers, environment.toolkit.path, {
		warn: () => {},
	})
	await runner.assertBridgedSingletons(bridgeSpecifiers)
} finally {
	await server.close()
}
