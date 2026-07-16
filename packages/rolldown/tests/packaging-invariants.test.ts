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
		expect(rolldown.exports).toHaveProperty('./build')
		expect(rolldown.exports).toHaveProperty('./vite/environment')
		expect(rolldown.exports).toHaveProperty('./resolver/oxc')
		expect(rolldown.exports).toHaveProperty('./workbench/artifact')

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

	it('keeps Vite and Module Federation lazy behind Workbench UI declarations', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const pluginCode = await readFile(
			`${root}/packages/rolldown/src/rolldown/plugins/workbenchUiBuildPlugin.ts`,
			'utf8',
		)

		expect(pluginCode).toContain("import('../../vite/workbench-ui.ts')")
		expect(pluginCode).toContain("from '../../workbench/build-contract.ts'")
		expect(pluginCode).not.toMatch(/import\s+\{[^}]*buildWorkbenchUiRemote[^}]*\}\s+from/)
		expect(pluginCode).not.toContain('@module-federation/vite')
	})

	it('keeps workbench UI Module Federation build logic and direct deps in one place', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDynamicFiles = await collectSourceFiles(`${root}/packages/runtime-dynamic/src`)
		const runtimeDevFiles = await collectSourceFiles(`${root}/packages/runtime-dev/src`)
		const runtimeStatic = await readJson(`${root}/packages/runtime-static/package.json`)
		const runtimeStaticTsdown = await readFile(
			`${root}/packages/runtime-static/tsdown.config.ts`,
			'utf8',
		)
		const offenders: string[] = []

		for (const file of [...runtimeDynamicFiles, ...runtimeDevFiles]) {
			const code = await readFile(file, 'utf8')
			if (code.includes('@module-federation/vite')) offenders.push(file)
		}

		expect(
			offenders,
			'runtime-dynamic should call @pluxel/rolldown/vite/workbench-ui instead of owning MF build logic',
		).toEqual([])
		expect(runtimeStatic.dependencies).not.toHaveProperty('@pluxel/rolldown')
		expect(runtimeStatic.devDependencies).toHaveProperty('@pluxel/rolldown')
		expect(runtimeStatic.peerDependencies).toHaveProperty('@pluxel/rolldown')
		expect(runtimeStatic.peerDependenciesMeta?.['@pluxel/rolldown']?.optional).toBe(true)
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/vite')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/dts-plugin')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/runtime')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/runtime-core')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@module-federation/sdk')
		expect(runtimeStatic.dependencies).not.toHaveProperty('oxc-parser')
		expect(runtimeStatic.dependencies).not.toHaveProperty('oxc-resolver')
		expect(runtimeStatic.dependencies).not.toHaveProperty('pathe')
		expect(runtimeStatic.dependencies).not.toHaveProperty('typescript')
		expect(runtimeStatic.dependencies).not.toHaveProperty('nf3')
		expect(runtimeStatic.dependencies).not.toHaveProperty('unplugin-macros')
		expect(runtimeStaticTsdown).not.toContain('@module-federation/vite')
		expect(runtimeStaticTsdown).not.toContain('oxc-parser')
		expect(runtimeStaticTsdown).not.toContain('oxc-resolver')
		expect(runtimeStaticTsdown).not.toContain('typescript')
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

	it('keeps runtime application helpers on route package main entries in app code', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = [
			...(await collectSourceFiles(`${root}/packages/plugins/host/src`)),
			...(await collectSourceFiles(`${root}/packages/cli/templates/plugin/src`)),
		]
		const offenders: string[] = []
		const staticViteApplicationHelper =
			/import\s+\{[^}]*defineStaticRuntime[^}]*\}\s+from\s+['"]@pluxel\/runtime-static\/vite['"]/
		const dynamicViteConfigHelper =
			/import\s+\{[^}]*defineDynamicRuntimeConfig[^}]*\}\s+from\s+['"]@pluxel\/runtime-dynamic\/vite['"]/

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			if (staticViteApplicationHelper.test(code) || dynamicViteConfigHelper.test(code))
				offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps static application freezing and residual tracing in the rolldown package', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const rolldown = await readJson(`${root}/packages/rolldown/package.json`)
		const runtime = await readJson(`${root}/packages/runtime/package.json`)
		const runtimeStatic = await readJson(`${root}/packages/runtime-static/package.json`)
		const buildEntry = await readFile(`${root}/packages/rolldown/src/cli/index.ts`, 'utf8')
		const freezer = await readFile(
			`${root}/packages/rolldown/src/cli/static-application.ts`,
			'utf8',
		)
		const pluginBuild = await readFile(`${root}/packages/rolldown/src/cli/plugin-build.ts`, 'utf8')
		const cliBuild = await readFile(`${root}/packages/cli/src/commands/build.ts`, 'utf8')
		const runtimeDevVite = await readFile(`${root}/packages/runtime-dev/src/vite.ts`, 'utf8')
		const viteSource = await readFile(`${root}/packages/rolldown/src/vite/plugin-source.ts`, 'utf8')
		const nodeApplication = await readFile(
			`${root}/packages/runtime-static/src/internal/node-application.ts`,
			'utf8',
		)
		const nodeWorkbenchApplication = await readFile(
			`${root}/packages/runtime-static/src/internal/node-workbench-application.ts`,
			'utf8',
		)
		const staticHost = await readFile(
			`${root}/packages/runtime-static/src/internal/host.ts`,
			'utf8',
		)

		expect(buildEntry).toContain("export * from './static-application'")
		expect(runtimeStatic.exports).toHaveProperty('./internal/node-application')
		expect(runtimeStatic.exports).toHaveProperty('./internal/node-workbench-application')
		expect(runtime.exports).toHaveProperty('./internal/static-host')
		expect(nodeApplication).not.toContain('@pluxel/runtime/internal/static')
		expect(nodeWorkbenchApplication).toContain('@pluxel/runtime/internal/static')
		expect(staticHost).toContain('@pluxel/runtime/internal/static-host')
		expect(staticHost).not.toContain("from '@pluxel/runtime/internal/static'")
		expect(freezer).toContain('export function staticApplication(')
		expect(freezer).toContain("await import('nf3')")
		expect(freezer).toContain('createPluginBuildPipeline({')
		expect(freezer).not.toContain('workbenchUiBuildPlugin(')
		expect(freezer).not.toContain('configSourcePlugin()')
		expect(freezer).not.toContain('lintGuardPlugin(')
		expect(freezer).toContain('entry must default-export defineStaticRuntime(...) directly')
		expect(pluginBuild).toContain('export function pluginPackage(')
		expect(pluginBuild).toContain('export function createPluginBuildPipeline(')
		expect(pluginBuild).toContain("from 'unplugin-macros/rolldown'")
		expect(pluginBuild).toContain("from 'unplugin-preprocessor-directives/rollup'")
		expect(pluginBuild).toContain('lintGuardPlugin(')
		expect(pluginBuild).toContain('configSourcePlugin()')
		expect(pluginBuild).toContain('workbenchUiBuildPlugin(')
		expect(pluginBuild).toContain('legacy: true')
		expect(pluginBuild).toContain('emitDecoratorMetadata: true')
		expect(pluginBuild).toContain("name: 'pluxel:decorator-output-guard'")
		expect(cliBuild).toContain('build.pluginPackage({')
		expect(cliBuild).not.toContain('configSourcePlugin(')
		expect(cliBuild).not.toContain('workbenchUiBuildPlugin(')
		expect(runtimeDevVite).not.toContain('pluginSourceVitePlugins')
		expect(runtimeDevVite).not.toContain('configSourcePlugin(')
		expect(runtimeDevVite).not.toContain('lintGuardPlugin(')
		expect(viteSource).toContain('export function pluxelRuntimeSourceVitePlugins(')
		expect(viteSource).not.toContain('unplugin-macros')
		expect(viteSource).toContain("from 'unplugin-preprocessor-directives/vite'")
		expect(rolldown.dependencies).toHaveProperty('nf3')
		expect(rolldown.dependencies).toHaveProperty('unplugin-macros')
		expect(runtimeStatic.dependencies).not.toHaveProperty('nf3')
		expect(runtimeStatic.dependencies).not.toHaveProperty('unplugin-macros')
	})

	it('keeps static runtime state independent from minifiable constructor names', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const sourceFiles = [
			...(await collectSourceFiles(`${root}/packages/plugins`)),
			...(await collectSourceFiles(`${root}/projects`)),
		].filter((file) => file.endsWith('/pluxel.static.ts'))
		const files = [
			...sourceFiles,
			`${root}/packages/cli/templates/app-monorepo/web/src/pluxel.static.ts.hbs`,
		]
		const offenders: string[] = []

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			if (/\.map\(\s*\([^)]*\)\s*=>\s*[^)]*\.name\s*\)/.test(code)) offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps one runtime authoring entry and one always-on service registry', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const coreManifest = await readJson(`${root}/packages/core/package.json`)
		const coreIndex = await readFile(`${root}/packages/core/src/index.ts`, 'utf8')
		const runtimeIndex = await readFile(`${root}/packages/runtime/src/index.ts`, 'utf8')
		const runtimeServices = await readFile(`${root}/packages/runtime/src/services/index.ts`, 'utf8')
		const runtimeStaticIndex = await readFile(
			`${root}/packages/runtime-static/src/index.ts`,
			'utf8',
		)
		const runtimeDynamicIndex = await readFile(
			`${root}/packages/runtime-dynamic/src/index.ts`,
			'utf8',
		)
		const runtimeManifest = JSON.parse(
			await readFile(`${root}/packages/runtime/package.json`, 'utf8'),
		) as { exports?: Record<string, unknown> }
		const runtimeDynamicManifest = JSON.parse(
			await readFile(`${root}/packages/runtime-dynamic/package.json`, 'utf8'),
		) as { exports?: Record<string, unknown> }
		const configSourcePlugin = await readFile(
			`${root}/packages/rolldown/src/rolldown/plugins/configSourcePlugin.ts`,
			'utf8',
		)

		expect(coreIndex).toContain("import './logger'")
		expect(coreIndex).toContain("import './services'")
		expect(coreIndex).toContain("export { EvtChannel } from './services'")
		expect(coreManifest.exports).not.toHaveProperty('./env')
		expect(existsSync(`${root}/packages/core/src/env.ts`)).toBe(false)
		expect(runtimeIndex).toContain("import './services'")
		expect(runtimeIndex).not.toContain("import './services/vault'")
		expect(runtimeIndex).toContain("export * from '@pluxel/core'")
		expect(runtimeServices).toContain("import './ConfigService'")
		expect(runtimeServices).toContain("import './workbench/WorkbenchService'")
		expect(runtimeServices).not.toContain('vault')
		expect(runtimeStaticIndex).toContain("from '@pluxel/runtime'")
		expect(runtimeStaticIndex).not.toContain('/register/')
		expect(runtimeDynamicIndex).toContain("import './services'")
		expect(runtimeManifest.exports?.['./authoring']).toBeUndefined()
		expect(runtimeManifest.exports?.['./register/full']).toBeUndefined()
		expect(runtimeManifest.exports?.['./register/static']).toBeUndefined()
		expect(runtimeManifest.exports?.['./frozen']).toBeUndefined()
		expect(runtimeDynamicManifest.exports?.['./register']).toBeUndefined()
		expect(configSourcePlugin).toContain(
			"const DEFAULT_METADATA_HELPER_IMPORT_SOURCE = '@pluxel/runtime/toolchain'",
		)
	})

	it('keeps Workbench compiler attachment lifecycle in runtime-dev', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDevWorkbench = await readFile(
			`${root}/packages/runtime-dev/src/workbench.ts`,
			'utf8',
		)
		const runtimeCapabilities = await readFile(
			`${root}/packages/runtime/src/runtime/capabilities.ts`,
			'utf8',
		)
		const workbenchService = await readFile(
			`${root}/packages/runtime/src/services/workbench/WorkbenchService.ts`,
			'utf8',
		)
		const staticVite = await readFile(`${root}/packages/runtime-static/src/vite.ts`, 'utf8')
		const dynamicHost = await readFile(`${root}/packages/runtime-dynamic/src/hmr/host.ts`, 'utf8')

		expect(runtimeDevWorkbench).toContain('export function attachWorkbenchCompiler(')
		expect(runtimeDevWorkbench).toContain('new WorkbenchCompilerService(')
		expect(runtimeDevWorkbench).toContain('artifacts.attachSourceBinder(')
		expect(runtimeDevWorkbench).not.toContain('ctx.runtimeDev =')
		expect(runtimeCapabilities).not.toContain('workbenchUiSource')
		expect(workbenchService).not.toContain('interface WorkbenchBackend')
		expect(staticVite).toContain('runtimeDev.attachWorkbenchCompiler(ctx,')
		expect(staticVite).not.toContain('new runtimeDev.WorkbenchCompilerService(')
		expect(dynamicHost).toContain('attachWorkbenchCompiler(ctx,')
		expect(dynamicHost).not.toContain('new WorkbenchCompilerService(')
	})

	it('keeps dev/HMR capabilities out of the runtime route contract', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const capabilities = await readFile(
			`${root}/packages/runtime/src/runtime/capabilities.ts`,
			'utf8',
		)
		const pluginApi = await readFile(`${root}/packages/runtime/src/plugin.ts`, 'utf8')

		const routeType = capabilities.match(
			/export type RuntimeRouteCapabilities = \{[\s\S]*?\n\}/,
		)?.[0]
		expect(routeType).toBeTruthy()
		expect(routeType).not.toContain('dev?:')
		expect(capabilities).toContain('runtimeDev?: RuntimeDevCapabilities')
		expect(pluginApi).toContain('runtimeDevCapabilities(ctx)')
		expect(pluginApi).not.toContain('runtimeRoute(ctx)?.dev')
	})

	it('keeps old HTTP workbench internals out of public runtime config surfaces', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = [
			...(await collectSourceFiles(`${root}/packages/plugins/host/src`)),
			...(await collectSourceFiles(`${root}/packages/cli/templates/plugin/src`)),
			`${root}/packages/runtime-static/src/types.ts`,
			`${root}/packages/runtime-static/src/index.ts`,
		]
		const forbidden = ['controlPlane', 'uiAssets', 'uiPublicDir', 'UiAssetStrategy']
		const offenders: string[] = []

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			for (const token of forbidden) {
				if (code.includes(token)) offenders.push(`${file}:${token}`)
			}
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
