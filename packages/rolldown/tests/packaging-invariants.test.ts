import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

type PackageJson = {
	exports?: unknown
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
	inlinedDependencies?: Record<string, string>
}

async function readJson(path: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path, 'utf8')) as PackageJson
}

async function collectSourceFiles(dir: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (current: string) => {
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const ent of entries) {
			if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.turbo') continue
			const next = join(current, ent.name)
			if (ent.isDirectory()) {
				await walk(next)
				continue
			}
			if (/\.(?:ts|tsx|mts|cts)$/.test(ent.name)) out.push(next)
		}
	}
	await walk(dir)
	return out.sort()
}

describe('toolchain package boundaries', () => {
	it('keeps Vite toolchain helpers out of runtime public exports', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtime = await readJson(`${root}/packages/runtime/package.json`)
		const runtimeDynamic = await readJson(`${root}/packages/runtime-dynamic/package.json`)
		const runtimeStatic = await readJson(`${root}/packages/runtime-static/package.json`)
		const runtimeDev = await readJson(`${root}/packages/runtime-dev/package.json`)
		const rolldown = await readJson(`${root}/packages/rolldown/package.json`)

		expect(runtime.exports).not.toHaveProperty('./vite')
		expect(existsSync(`${root}/packages/runtime/src/vite.ts`)).toBe(false)
		expect(
			existsSync(`${root}/packages/runtime/src/services/runtime/shared/vite-environment.ts`),
		).toBe(false)
		expect(runtimeDynamic.exports).toHaveProperty('./vite')
		expect(runtimeDynamic.exports).toHaveProperty('./hmr')
		expect(runtimeStatic.exports).toHaveProperty('./vite')
		expect(runtimeStatic.exports).not.toHaveProperty('./hmr')
		expect(rolldown.exports).toHaveProperty('./vite')
		expect(rolldown.exports).toHaveProperty('./vite/environment')
		expect(rolldown.exports).toHaveProperty('./resolver/oxc')

		for (const pkg of [runtimeDynamic, runtimeStatic, runtimeDev]) {
			expect(pkg.dependencies).not.toHaveProperty('vite')
			expect(pkg.devDependencies).toHaveProperty('vite')
			expect(pkg.peerDependencies).toHaveProperty('vite', '>=8.0.0-beta.18 <9')
			expect(pkg.peerDependenciesMeta?.vite?.optional).toBe(true)
		}
		for (const pkg of [runtimeDynamic, runtimeStatic]) {
			expect(pkg.dependencies).not.toHaveProperty('@pluxel/runtime-dev')
			expect(pkg.devDependencies).toHaveProperty('@pluxel/runtime-dev')
		}
	})

	it('keeps plugin UI Module Federation build logic and direct deps in one place', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDynamicFiles = await collectSourceFiles(`${root}/packages/runtime-dynamic/src`)
		const runtimeDevFiles = await collectSourceFiles(`${root}/packages/runtime-dev/src`)
		const runtimeStatic = await readJson(`${root}/packages/runtime-static/package.json`)
		const offenders: string[] = []

		for (const file of [...runtimeDynamicFiles, ...runtimeDevFiles]) {
			const code = await readFile(file, 'utf8')
			if (code.includes('@module-federation/vite')) offenders.push(file)
		}

		expect(
			offenders,
			'runtime-dynamic should call @pluxel/rolldown/vite/plugin-ui instead of owning MF build logic',
		).toEqual([])
		expect(runtimeStatic.dependencies).toHaveProperty('@module-federation/vite')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/dts-plugin')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/runtime')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/runtime-core')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/sdk')
	})

	it('keeps Rolldown plugin utility dependencies inside the rolldown package', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDynamic = await readJson(`${root}/packages/runtime-dynamic/package.json`)

		expect(runtimeDynamic.dependencies).not.toHaveProperty('@rolldown/pluginutils')
	})

	it('keeps published consumers from vendoring complex rolldown toolchain entries', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const configs = [
			`${root}/packages/cli/tsdown.config.ts`,
			`${root}/packages/runtime-dev/tsdown.config.ts`,
			`${root}/packages/runtime-dynamic/tsdown.config.ts`,
			`${root}/packages/runtime-static/tsdown.config.ts`,
			`${root}/packages/test/tsdown.config.ts`,
		]

		for (const configPath of configs) {
			const code = await readFile(configPath, 'utf8')
			expect(code).not.toMatch(/alwaysBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
			expect(code).not.toContain('../rolldown/src/rolldown')
			expect(code).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		}
	})

	it('keeps the CLI from importing complex sibling package source directly', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const cliFiles = await collectSourceFiles(`${root}/packages/cli/src`)
		const offenders: string[] = []

		for (const file of cliFiles) {
			const code = await readFile(file, 'utf8')
			if (code.includes('../runtime/src/') || code.includes('../runtime-dynamic/src/'))
				offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps runtime hmr packaging boundaries explicit', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeConfig = await readFile(`${root}/packages/runtime/tsdown.config.ts`, 'utf8')
		const runtimePackage = await readFile(`${root}/packages/runtime/package.json`, 'utf8')
		const runtimeIndex = await readFile(`${root}/packages/runtime/src/index.ts`, 'utf8')
		const runtimeTestEntry = await readFile(`${root}/packages/runtime/src/test.ts`, 'utf8')
		const runtimeRegisterFull = await readFile(
			`${root}/packages/runtime/src/runtime/register/full.ts`,
			'utf8',
		)
		const runtimeRegisterStatic = await readFile(
			`${root}/packages/runtime/src/runtime/register/static.ts`,
			'utf8',
		)
		const runtimeDevConfig = await readFile(`${root}/packages/runtime-dev/tsdown.config.ts`, 'utf8')
		const coreConfig = await readFile(`${root}/packages/core/tsdown.config.ts`, 'utf8')
		const corePackage = await readJson(`${root}/packages/core/package.json`)
		const contextPackage = await readJson(`${root}/packages/context/package.json`)
		const runtimeDynamicConfig = await readFile(
			`${root}/packages/runtime-dynamic/tsdown.config.ts`,
			'utf8',
		)
		const runtimeStaticConfig = await readFile(
			`${root}/packages/runtime-static/tsdown.config.ts`,
			'utf8',
		)
		const runtimeDevVite = await readFile(`${root}/packages/runtime-dev/src/vite.ts`, 'utf8')
		const runtimeDevExtensionCompiler = await readFile(
			`${root}/packages/runtime-dev/src/extensions/ExtensionCompilerService.ts`,
			'utf8',
		)
		const runtimeDynamicHmrConfig = await readFile(
			`${root}/packages/runtime-dynamic/src/hmr/engine/config.ts`,
			'utf8',
		)
		const runtimeDynamicVite = await readFile(
			`${root}/packages/runtime-dynamic/src/vite.ts`,
			'utf8',
		)
		const runtimeDynamicPackage = await readFile(
			`${root}/packages/runtime-dynamic/package.json`,
			'utf8',
		)
		const runtimeStaticVite = await readFile(`${root}/packages/runtime-static/src/vite.ts`, 'utf8')
		const runtimeStaticIndex = await readFile(
			`${root}/packages/runtime-static/src/index.ts`,
			'utf8',
		)
		const runtimeStaticTypes = await readFile(
			`${root}/packages/runtime-static/src/types.ts`,
			'utf8',
		)
		const runtimeStaticCatalog = await readFile(
			`${root}/packages/runtime-static/src/internal/catalog.ts`,
			'utf8',
		)
		const runtimeStaticHost = await readFile(
			`${root}/packages/runtime-static/src/internal/host.ts`,
			'utf8',
		)
		const runtimeStateEntry = await readFile(
			`${root}/packages/runtime/src/runtime-state.ts`,
			'utf8',
		)
		const runtimeInternal = await readFile(`${root}/packages/runtime/src/internal.ts`, 'utf8')
		const runtimeWorkspaceFs = await readFile(
			`${root}/packages/runtime/src/runtime/workspace-fs.ts`,
			'utf8',
		)
		const runtimePlugin = await readFile(`${root}/packages/runtime/src/plugin.ts`, 'utf8')
		const runtimeRpcApi = await readFile(
			`${root}/packages/runtime/src/api/http/rpc/RuntimeRpcApi.ts`,
			'utf8',
		)
		const runtimeCapabilities = await readFile(
			`${root}/packages/runtime/src/runtime/capabilities.ts`,
			'utf8',
		)
		const runtimeProtocol = await readFile(`${root}/packages/runtime/src/web/protocol.ts`, 'utf8')
		const runtimeWebPaths = await readFile(`${root}/packages/runtime/src/web/paths.ts`, 'utf8')
		const runtimeWeb = await readFile(`${root}/packages/runtime/src/web.ts`, 'utf8')
		const runtimeDynamicRoute = await readFile(
			`${root}/packages/runtime-dynamic/src/catalog/LoaderRuntimeRoute.ts`,
			'utf8',
		)
		const runtimeDynamicPackageService = await readFile(
			`${root}/packages/runtime-dynamic/src/package/PackageService.ts`,
			'utf8',
		)
		const runtimeDynamicPackageLoader = await readFile(
			`${root}/packages/runtime-dynamic/src/package/loader.ts`,
			'utf8',
		)
		const runtimeConfigService = await readFile(
			`${root}/packages/runtime/src/services/ConfigService.ts`,
			'utf8',
		)
		const runtimeStateStore = await readFile(
			`${root}/packages/runtime/src/services/RuntimeStateStore.ts`,
			'utf8',
		)
		const runtimePersistenceService = await readFile(
			`${root}/packages/runtime/src/services/persistence/PersistenceService.ts`,
			'utf8',
		)
		const runtimeLoggerPolicy = await readFile(
			`${root}/packages/runtime/src/logger/policy.ts`,
			'utf8',
		)
		const runtimeHttpService = await readFile(
			`${root}/packages/runtime/src/services/http/HttpService.ts`,
			'utf8',
		)
		const runtimeDynamicPackageMutation = await readFile(
			`${root}/packages/runtime-dynamic/src/package/mutation.ts`,
			'utf8',
		)
		const runtimeDynamicPackageLoadRuntime = await readFile(
			`${root}/packages/runtime-dynamic/src/package/load-runtime.ts`,
			'utf8',
		)
		const runtimeDynamicPackageInventory = await readFile(
			`${root}/packages/runtime-dynamic/src/package/inventory.ts`,
			'utf8',
		)
		const staticDemoVite = await readFile(
			`${root}/packages/plugins/static-commercial-demo/vite.config.ts`,
			'utf8',
		)
		const staticCommercialConfig = await readFile(
			`${root}/packages/plugins/static-commercial-demo/src/pluxel.static.ts`,
			'utf8',
		)
		const pluginsHostStaticConfig = await readFile(
			`${root}/packages/plugins/host/src/pluxel.static.ts`,
			'utf8',
		)
		const pluginsHostDynamicConfig = await readFile(
			`${root}/packages/plugins/host/src/pluxel.dynamic.ts`,
			'utf8',
		)
		const pluginsHostStatic = await readFile(`${root}/packages/plugins/host/src/static.ts`, 'utf8')
		const staticCommercialHost = await readFile(
			`${root}/packages/plugins/static-commercial-demo/src/static.ts`,
			'utf8',
		)

		expect(runtimeConfig).toContain('onlyBundle: []')
		expect(runtimeConfig).toContain('../rolldown/src/workspace/fs-entry.ts')
		expect(runtimeConfig).toContain('../rolldown/src/workspace/info-entry.ts')
		expect(runtimeConfig).not.toContain('../rolldown/src/rolldown')
		expect(runtimeConfig).not.toContain('@pluxel/rolldown/vite')
		expect(existsSync(`${root}/packages/runtime/src/logger/LogtapeLoggerService.ts`)).toBe(false)
		expect(existsSync(`${root}/packages/runtime/src/services.ts`)).toBe(false)
		expect(existsSync(`${root}/packages/runtime/src/runtime/register.ts`)).toBe(false)
		expect(existsSync(`${root}/packages/runtime/src/services/http/node-adapters.ts`)).toBe(false)
		expect(runtimeConfig).not.toContain("services: 'src/services.ts'")
		expect(runtimeConfig).not.toContain("config: 'src/config.ts'")
		expect(runtimePackage).not.toContain('"./services"')
		expect(runtimePackage).not.toContain('"./config"')
		expect(runtimeIndex).not.toContain('bootstrapHostVault')
		expect(runtimeIndex).toContain("export { f, v } from './config'")
		expect(runtimeTestEntry).toContain("from './services/vault'")
		expect(runtimeTestEntry).not.toContain('./services/security/bootstrap')
		expect(runtimeInternal).toContain('createNodeWorkspaceFsBackend')
		expect(runtimeInternal).not.toContain('createNodeFsServiceBackend')
		expect(runtimeWorkspaceFs).not.toContain('@RootService')
		expect(runtimeWorkspaceFs).not.toContain('interface RootServices')
		expect(runtimeWorkspaceFs).not.toContain("const serviceName = 'fs'")
		expect(runtimeRegisterFull).not.toContain('services/fs/FsService')
		expect(runtimeRegisterStatic).not.toContain('services/fs/FsService')
		expect(existsSync(`${root}/packages/runtime/src/runtime/hmr-${'handles'}.ts`)).toBe(false)
		expect(existsSync(`${root}/packages/runtime/src/runtime/module-${'runtime'}.ts`)).toBe(false)
		expect(runtimeInternal).not.toContain(`setHmr${'RuntimeHandles'}`)
		expect(runtimeInternal).not.toContain(`getHmr${'RuntimeHandles'}`)
		expect(runtimeInternal).not.toContain(`setRuntime${'ModuleAdapter'}`)
		expect(runtimeInternal).not.toContain(`getRuntime${'ModuleAdapter'}`)
		expect(runtimePlugin).not.toContain(`getHmr${'RuntimeHandles'}`)
		expect(runtimePlugin).toContain('runtimeRoute(ctx)?.dev')
		expect(runtimePlugin).not.toContain('node:url')
		expect(runtimePlugin).not.toContain('pathToFileURL')
		expect(runtimeCapabilities).toContain('modules?: RuntimeModuleRuntime')
		expect(runtimeCapabilities).toContain('dev?: RuntimeDevCapabilities')
		expect(runtimeCapabilities).toContain('features?: RuntimeRouteFeatures')
		expect(runtimeRpcApi).not.toContain("from '../../../services'")
		expect(runtimeRpcApi).not.toContain('from "../../../services"')
		expect(runtimeRpcApi).toContain('features(): string[]')
		expect(runtimeRpcApi).toContain('feature<Name extends RuntimeRouteFeatureName>')
		expect(runtimeRpcApi).not.toContain(`package():`)
		expect(runtimeProtocol).toContain('PackageManagerFeatureApi')
		expect(runtimeProtocol).toContain('feature: <Name extends RuntimeRouteFeatureName>')
		expect(runtimeProtocol).not.toContain('PackageHandleApi')
		expect(runtimeProtocol).not.toContain(`package: () =>`)
		expect(runtimeDynamicRoute).toContain('features: {')
		expect(runtimeDynamicRoute).toContain('packageManager:')
		expect(runtimeDynamicRoute).not.toContain('rpcHandles')
		expect(runtimeDynamicPackageService).toContain('new PackageMutationService')
		expect(runtimeDynamicPackageService).toContain('new PackageLoadRuntime')
		expect(runtimeDynamicPackageService).toContain('new PackageInventoryService')
		expect(runtimeDynamicPackageService).toContain(
			"this.ctx.root.persistence.namespace('package-state')",
		)
		expect(runtimeDynamicPackageService).not.toContain('ctx.root.fs')
		expect(runtimeDynamicPackageLoader).toContain('import(/* @vite-ignore */ url.href)')
		expect(runtimeConfigService).toContain('ctx.root.persistence.namespace')
		expect(runtimeConfigService).not.toContain('ctx.config as unknown as { fs')
		expect(runtimeStateStore).toContain('ctx.root.persistence.namespace')
		expect(runtimeStateStore).not.toContain('ctx.config as unknown as { fs')
		expect(runtimePersistenceService).not.toContain('ctx.config as unknown as { fs')
		expect(runtimeLoggerPolicy).not.toContain('node:fs')
		expect(runtimeHttpService).toContain('createLazyGraphqlBoundary')
		expect(runtimeHttpService).toContain("import('./internalApi')")
		expect(runtimeHttpService).toContain('this.config.graphql')
		expect(runtimeHttpService).not.toContain(
			'this.createLazyInternalApiBoundary({\n\t\t\t\t\tgraphql: this.config.graphql',
		)
		expect(runtimeDynamicPackageMutation).toContain('class PackageMutationService')
		expect(runtimeDynamicPackageMutation).toContain('removePackages(')
		expect(runtimeDynamicPackageLoadRuntime).toContain('class PackageLoadRuntime')
		expect(runtimeDynamicPackageLoadRuntime).toContain('invalidatePackage(')
		expect(runtimeDynamicPackageInventory).toContain('class PackageInventoryService')
		expect(runtimeDynamicPackageInventory).toContain('listInstalledPackages(')
		expect(runtimeWebPaths).toContain("RUNTIME_INTERNAL_API_BASE = '/__pluxel/runtime'")
		expect(runtimeWebPaths).not.toContain('HMR_')
		expect(runtimeWebPaths).not.toContain(`/__pluxel/${'hmr'}`)
		expect(runtimeWeb).toContain('RUNTIME_INTERNAL_API_BASE')
		expect(runtimeWeb).not.toContain('HMR_')
		expect(coreConfig).toMatch(/alwaysBundle:\s*\[[^\]]*['"]@pluxel\/context/)
		expect(coreConfig).not.toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/context/)
		expect(corePackage.dependencies).not.toHaveProperty('@pluxel/context')
		expect(corePackage.devDependencies).toHaveProperty('@pluxel/context')
		expect(contextPackage).toHaveProperty('private', true)
		expect(JSON.stringify(contextPackage.exports)).toContain('@pluxel/source')
		expect(runtimeDevConfig).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		expect(runtimeDevConfig).not.toContain('../rolldown/src/')
		expect(runtimeDynamicConfig).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		expect(runtimeDynamicConfig).not.toContain('../rolldown/src/')
		expect(runtimeDynamicConfig).toContain("alwaysBundle: ['@pluxel/runtime-dev'")
		expect(runtimeDynamicConfig).toContain('../runtime-dev/src/index.ts')
		expect(runtimeDynamicConfig).toContain('../runtime-dev/src/vite.ts')
		expect(runtimeStaticConfig).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		expect(runtimeStaticConfig).toContain("alwaysBundle: ['@pluxel/runtime-dev'")
		expect(runtimeStaticConfig).toContain('../runtime-dev/src/index.ts')
		expect(runtimeStaticConfig).toContain('../runtime-dev/src/vite.ts')
		expect(runtimeDevVite).toContain('@pluxel/rolldown/plugins')
		expect(runtimeDevVite).toContain('@pluxel/rolldown/vite')
		expect(runtimeDevVite).toContain('configSourcePlugin')
		expect(runtimeDevVite).toContain('runtimeUiBridgePlugin')
		expect(runtimeDevVite).toContain('pluxelRuntimeSourceVitePlugin')
		expect(runtimeDevVite).toContain('pluxelRuntimeUiBridgeVitePlugin')
		expect(runtimeDevVite).toContain('PLUXEL_EXTERNAL_RESOLVE_CONDITIONS')
		expect(runtimeDevVite).toContain('external: [...PLUXEL_SINGLETON_PACKAGES]')
		expect(runtimeDevVite).not.toContain("'@pluxel/context',")
		expect(runtimeDevVite).not.toContain('pluxelRuntimeDevVitePlugin')
		expect(runtimeDevVite).not.toContain('pluxelRuntimeDevVitePlugins')
		expect(runtimeDevVite).not.toContain('runtimeDevSourceVitePlugins')
		expect(runtimeDevVite).not.toContain('runtimeDevLegacyDecoratorPlugin')
		expect(runtimeDevVite).not.toContain('runtimeUiBridge?:')
		expect(runtimeDevVite).not.toContain('resolveUiBridgeOptions')
		expect(runtimeDevVite).toContain('legacy: true')
		expect(runtimeDevExtensionCompiler).not.toContain('attachStore')
		expect(runtimeDevExtensionCompiler).toContain('store: ExtensionModuleStore')
		expect(runtimeDynamicHmrConfig).toContain('@pluxel/runtime-dev/vite')
		expect(runtimeDynamicHmrConfig).toContain('pluxelRuntimeSourceVitePlugin')
		expect(runtimeDynamicHmrConfig).toContain('/packages/runtime-dynamic/')
		expect(runtimeDynamicHmrConfig).not.toContain('/packages/runtime/')
		expect(runtimeDynamicHmrConfig).not.toContain('market loader')
		expect(runtimeDynamicHmrConfig).not.toContain('pluxelRuntimeDevVitePlugin')
		expect(runtimeDynamicHmrConfig).not.toContain(`runtime${'UiBridge'}: false`)
		const runtimeDynamicHmr = await readFile(`${root}/packages/runtime-dynamic/src/hmr.ts`, 'utf8')
		expect(runtimeDynamicHmr).not.toContain(`createLoader${'HmrHost'}`)
		expect(runtimeDynamicHmr).not.toContain(`createLoader${'HmrHostFromSnapshot'}`)
		expect(runtimeDynamicHmr).not.toContain(`installLoader${'Hmr'}`)
		const runtimeDynamicHmrFiles = await readdir(`${root}/packages/runtime-dynamic/src/hmr`)
		expect(runtimeDynamicHmrFiles.filter((file) => file.endsWith('-runtime.ts'))).toEqual([])
		const loaderHmrService = await readFile(
			`${root}/packages/runtime-dynamic/src/hmr/engine/LoaderHmrService.ts`,
			'utf8',
		)
		expect(loaderHmrService).not.toContain(`attach${'Server'}`)
		const runtimeDynamicHost = await readFile(
			`${root}/packages/runtime-dynamic/src/hmr/host.ts`,
			'utf8',
		)
		expect(runtimeDynamicHost).not.toContain(`attachLoader${'HmrRuntime'}`)
		expect(runtimeDynamicHost).not.toContain(`configureLoader${'HmrRuntime'}`)
		expect(runtimeDynamicHost).not.toContain('@pluxel/runtime/services/vault')
		expect(runtimeDynamicHost).not.toContain('bootstrapHostVault')
		expect(runtimeDynamicHmr).not.toContain(`Loader${'HmrOptions'}`)
		const runtimeStaticHmr = await readFile(`${root}/packages/runtime-static/src/hmr.ts`, 'utf8')
		expect(runtimeStaticHmr).not.toContain(`installStatic${'RuntimeHmr'}`)
		const runtimeDevIndex = await readFile(`${root}/packages/runtime-dev/src/index.ts`, 'utf8')
		expect(runtimeDevIndex).not.toContain(`installExtension${'DevRuntime'}`)
		expect(runtimeDynamicVite).toContain('@pluxel/runtime-dev/vite')
		expect(runtimeDynamicVite).toContain('defineDynamicRuntimeConfig')
		expect(runtimeDynamicVite).toContain('dynamicRuntimeVitePlugin')
		expect(runtimeDynamicVite).toContain('pluxelRuntimeSourceVitePlugin')
		expect(runtimeDynamicVite).toContain('must not include an "hmr" field')
		expect(runtimeDynamicVite).not.toContain('createServer(')
		expect(runtimeDynamicPackage).toContain('"./vite"')
		expect(runtimeDynamicConfig).not.toContain('@pluxel/runtime/config')
		expect(runtimeStateEntry).toContain('./services/RuntimeStateHelpers')
		expect(runtimeStateEntry).not.toContain('RuntimeStateStore }')
		expect(runtimeStaticHost).toContain('@pluxel/runtime/runtime-state')
		expect(runtimeStaticHost).not.toContain("from '@pluxel/runtime/services'")
		expect(runtimeStaticVite).toContain('@pluxel/runtime-dev/vite')
		expect(runtimeStaticVite).toContain('pluxelRuntimeSourceVitePlugin')
		expect(runtimeStaticVite).toContain('pluxelRuntimeUiBridgeVitePlugin')
		expect(runtimeStaticVite).toContain('hmrOptions && hmrOptions.enableWebManagement !== false')
		expect(runtimeStaticVite).not.toContain('if (hmr !== false) {\n\t\t\t\tconst enabledHmrOptions')
		expect(runtimeStaticVite).toContain('defineStaticRuntimeConfig')
		expect(runtimeStaticVite).toContain('staticRuntimeVitePlugin')
		expect(runtimeStaticVite).toContain('options.hmr')
		expect(runtimeStaticVite).not.toContain('state.runtimeConfig?.hmr')
		expect(runtimeStaticVite).not.toContain('StaticRuntimeConfig & {')
		expect(runtimeStaticVite).toContain('must not include an "hmr" field')
		expect(runtimeStaticVite).not.toContain(`export function shouldHandleStatic${'RuntimeRequest'}`)
		expect(runtimeStaticVite).not.toContain(`StaticRuntime${'ViteHost'}`)
		expect(runtimeStaticVite).not.toContain(`StaticRuntime${'ExtensionCompilerConfig'}`)
		const removedStaticViteHelpers = [
			`staticRuntime${'Source'}VitePlugin`,
			`staticRuntime${'UiBridge'}VitePlugin`,
			`staticRuntime${'Host'}VitePlugin`,
		]
		for (const helper of removedStaticViteHelpers) {
			expect(runtimeStaticVite).not.toContain(helper)
		}
		expect(runtimeStaticVite).not.toContain('pluxelRuntimeDevVitePlugin')
		expect(runtimeStaticVite).not.toContain(`staticRuntimeVite${'Plugins'}`)
		expect(runtimeStaticVite).not.toContain('@pluxel/rolldown/plugins')
		expect(runtimeStaticVite).not.toContain('@pluxel/rolldown/vite')
		expect(runtimeStaticIndex).toContain('@pluxel/runtime/register/static')
		expect(runtimeStaticIndex).toContain('@pluxel/runtime')
		expect(runtimeStaticIndex).not.toContain('@pluxel/runtime/base')
		expect(runtimeStaticIndex).toContain('defineStaticRuntimeConfig')
		expect(runtimeStaticIndex).toContain('createStaticRuntime')
		expect(runtimeStaticIndex).not.toContain('export async function createStaticRuntimeHost')
		expect(runtimeStaticIndex).not.toContain('StaticRuntimeHost,')
		expect(runtimeStaticIndex).not.toContain('StaticRuntimeHmrController')
		expect(runtimeStaticIndex).not.toContain('StaticRuntimeHmrReport')
		expect(runtimeStaticIndex).not.toContain('defineStaticRuntime<T')
		expect(runtimeStaticIndex).not.toContain('function defineStaticRuntime')
		expect(runtimeStaticIndex).not.toContain('@pluxel/runtime/register/full')
		expect(runtimeStaticIndex).not.toContain('@pluxel/runtime-dev')
		expect(runtimeStaticIndex).not.toContain('@pluxel/runtime/services/vault')
		expect(runtimeStaticIndex).not.toContain('@pluxel/runtime/services/web-management')
		expect(runtimeStaticIndex).not.toContain('node:http')
		expect(runtimeStaticIndex).not.toContain('node:stream')
		expect(runtimeStaticIndex).not.toContain('/vite')
		expect(runtimeStaticTypes).not.toContain('@pluxel/runtime/services')
		expect(runtimeStaticTypes).toContain('@pluxel/runtime/runtime-state')
		expect(runtimeStaticCatalog).not.toContain('@pluxel/runtime/services')
		expect(staticDemoVite).toContain('staticRuntimeVitePlugin')
		for (const helper of removedStaticViteHelpers) {
			expect(staticDemoVite).not.toContain(helper)
		}
		expect(staticDemoVite).not.toContain(`staticRuntimeVite${'Plugins'}`)
		expect(staticDemoVite).not.toContain('runtimeUiBridge')
		expect(staticDemoVite).toContain("config: './src/pluxel.static.ts'")
		expect(staticDemoVite).not.toContain('pluxel.static.vite')
		expect(staticCommercialConfig).toContain('runtimeState')
		expect(staticCommercialConfig).toContain('snapshot: { enabled:')
		expect(staticCommercialHost).toContain('createStaticRuntime(staticRuntime)')
		expect(staticCommercialHost).toContain('startFetchHostServer')
		expect(staticCommercialHost).not.toContain('runtime.start()')
		expect(staticCommercialHost).not.toContain('...staticRuntime')
		expect(staticCommercialHost).not.toContain('createServer(')
		expect(staticCommercialHost).not.toContain('Readable.toWeb')
		expect(
			existsSync(`${root}/packages/plugins/static-commercial-demo/src/pluxel.static.vite.ts`),
		).toBe(false)
		expect(existsSync(`${root}/packages/plugins/static-commercial-demo/src/static-host.ts`)).toBe(
			false,
		)
		expect(pluginsHostStaticConfig).not.toContain("from './demo'")
		expect(pluginsHostStaticConfig).not.toContain('PluginHttpWorkerDemo')
		expect(pluginsHostStaticConfig).not.toContain('PluginVaultDemo')
		expect(pluginsHostStaticConfig).not.toContain('tinypool')
		expect(pluginsHostDynamicConfig).not.toContain("'PluginVaultDemo'")
		expect(pluginsHostStaticConfig).toContain('runtimeState')
		expect(pluginsHostStaticConfig).toContain('snapshot: { enabled:')
		expect(pluginsHostStatic).toContain('createStaticRuntime(staticRuntime)')
		expect(pluginsHostStatic).not.toContain('runtime.start()')
		expect(pluginsHostStatic).not.toContain('...staticRuntime')
		for (const staticHost of [pluginsHostStatic, staticCommercialHost]) {
			expect(staticHost).not.toContain(
				"configService: {\n\t\t\tmode: 'memory',\n\t\t\tsnapshot: { enabled:",
			)
			expect(staticHost).not.toContain(
				"configService: {\n\t\tmode: 'memory',\n\t\tsnapshot: { enabled:",
			)
		}
	})

	it('keeps native toolchain packages external to generated bundles', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const packageNames = [
			'cli',
			'rolldown',
			'runtime',
			'runtime-dev',
			'runtime-dynamic',
			'runtime-static',
			'test',
		]
		const offenders: string[] = []
		const nativeToolchainPackage =
			/^(?:oxc-(?:parser|resolver)|@oxc-(?:parser|resolver)\/binding-|rolldown|@rolldown\/binding-|oxlint|@oxlint\/binding-|oxfmt|@oxfmt\/binding-)$/

		for (const packageName of packageNames) {
			const pkg = await readJson(`${root}/packages/${packageName}/package.json`)
			for (const dep of Object.keys(pkg.inlinedDependencies ?? {})) {
				if (nativeToolchainPackage.test(dep)) offenders.push(`${packageName}:${dep}`)
			}
		}

		expect(offenders).toEqual([])
	})

	it('keeps demo plugins off the broad runtime services barrel', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = [
			...(await collectSourceFiles(`${root}/packages/plugins/host/src/demo`)),
			...(await collectSourceFiles(`${root}/packages/plugins/static-commercial-demo/src`)),
			...(await collectSourceFiles(`${root}/packages/cli/templates/plugin/src`)),
		]
		const offenders: string[] = []

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			if (
				code.includes("'@pluxel/runtime/services'") ||
				code.includes('"@pluxel/runtime/services"')
			) {
				offenders.push(file)
			}
			if (code.includes('@pluxel/runtime/config')) offenders.push(`${file}:@pluxel/runtime/config`)
			if (code.includes('@pluxel/runtime/base')) offenders.push(`${file}:@pluxel/runtime/base`)
		}

		expect(offenders).toEqual([])
	})

	it('keeps runtime config helpers on route package main entries in app code', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = [
			...(await collectSourceFiles(`${root}/packages/plugins/host/src`)),
			...(await collectSourceFiles(`${root}/packages/plugins/static-commercial-demo/src`)),
			...(await collectSourceFiles(`${root}/packages/cli/templates/plugin/src`)),
		]
		const offenders: string[] = []
		const staticViteConfigHelper =
			/import\s+\{[^}]*defineStaticRuntimeConfig[^}]*\}\s+from\s+['"]@pluxel\/runtime-static\/vite['"]/
		const dynamicViteConfigHelper =
			/import\s+\{[^}]*defineDynamicRuntimeConfig[^}]*\}\s+from\s+['"]@pluxel\/runtime-dynamic\/vite['"]/

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			if (staticViteConfigHelper.test(code) || dynamicViteConfigHelper.test(code))
				offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps refactor docs on split runtime registration entries', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const docs = [
			`${root}/docs/proposals/refactor-prompt.md`,
			`${root}/docs/proposals/static-fetch-native-runtime.md`,
			`${root}/docs/proposals/static-runtime-enterprise-refactor.md`,
			`${root}/docs/RUNTIME.md`,
		]
		const offenders: string[] = []

		for (const file of docs) {
			const code = await readFile(file, 'utf8')
			if (code.includes("import './runtime/register'")) offenders.push(file)
			if (code.includes('packages/runtime/src/runtime/register.ts')) offenders.push(file)
			if (code.includes('import 对应 bundle 或配置启用')) offenders.push(file)
			if (code.includes('配置启用后才挂')) offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps built static production entries free of dev and Node transport imports when present', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeStaticDistFiles = existsSync(`${root}/packages/runtime-static/dist`)
			? await readdir(`${root}/packages/runtime-static/dist`)
			: []
		const builtEntries = [
			`${root}/packages/runtime/dist/index.mjs`,
			`${root}/packages/runtime/dist/register/static.mjs`,
			`${root}/packages/runtime-static/dist/index.mjs`,
			...runtimeStaticDistFiles
				.filter((file) => /^host-.*\.mjs$/.test(file))
				.map((file) => `${root}/packages/runtime-static/dist/${file}`),
		]
		if (builtEntries.some((entry) => !existsSync(entry))) return

		const forbidden = [
			'node:http',
			'node:stream',
			'node:fs',
			'node-adapters',
			'createNodeHttpHandler',
			'FsService',
			'createNodeFsServiceBackend',
			'ctx.root.fs',
			'chokidar',
			'@pluxel/runtime-dev',
		]
		const forbiddenImports = [/[;}]\s*from["']vite["']/, /import\(["']vite["']\)/]
		const offenders: string[] = []
		for (const entry of builtEntries) {
			const code = await readFile(entry, 'utf8')
			for (const token of forbidden) {
				if (code.includes(token)) offenders.push(`${entry}:${token}`)
			}
			for (const pattern of forbiddenImports) {
				if (pattern.test(code)) offenders.push(`${entry}:${pattern.source}`)
			}
		}
		const staticIndexDts = `${root}/packages/runtime-static/dist/index.d.mts`
		if (existsSync(staticIndexDts)) {
			const indexDts = await readFile(staticIndexDts, 'utf8')
			const configDtsMatch = indexDts.match(/from "\.\/([^"]+\.mjs)"/)
			if (configDtsMatch) {
				const configDts = `${root}/packages/runtime-static/dist/${configDtsMatch[1].replace(/\.mjs$/, '.d.mts')}`
				const code = await readFile(configDts, 'utf8')
				if (code.includes('@pluxel/runtime/services'))
					offenders.push(`${configDts}:@pluxel/runtime/services`)
			}
		}

		expect(offenders).toEqual([])
	})
})
