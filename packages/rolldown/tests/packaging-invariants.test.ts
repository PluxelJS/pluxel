import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseSync } from 'oxc-parser'
import {
	WORKBENCH_FEDERATION_MANTINE_VERSION,
	WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION,
	WORKBENCH_FEDERATION_RUNTIME_VERSION,
	WORKBENCH_FEDERATION_VITE_VERSION,
} from '@pluxel/core/federation'
import { describe, expect, it } from 'vitest'
import { collectImportSpecifiers } from '../src/rolldown/plugins/importCollector.ts'
import { buildPluxelFrontendResolveConditions } from '../src/workspace/vite.ts'

type PackageJson = {
	private?: boolean
	types?: string
	files?: readonly string[]
	exports?: Record<string, unknown>
	publishConfig?: { exports?: Record<string, unknown> }
	scripts?: Record<string, string>
	compilerOptions?: Record<string, unknown>
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
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
			if (
				ent.name === 'node_modules' ||
				ent.name === 'dist' ||
				ent.name === '.turbo' ||
				ent.name.startsWith('fs-fixture-')
			)
				continue
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

async function collectPackageManifests(dir: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (current: string) => {
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const ent of entries) {
			if (
				ent.name === 'node_modules' ||
				ent.name === 'dist' ||
				ent.name === '.turbo' ||
				ent.name.startsWith('fs-fixture-')
			)
				continue
			const next = join(current, ent.name)
			if (ent.isDirectory()) {
				await walk(next)
				continue
			}
			if (ent.name === 'package.json') out.push(next)
		}
	}
	await walk(dir)
	return out.sort()
}

function quotedModuleSpecifiers(code: string): string[] {
	return [...code.matchAll(/(['"])([^'"\r\n]+)\1/g)].map((match) => match[2]!)
}

function importedModuleSpecifiers(file: string, code: string): string[] {
	const program = parseSync(file, code, {
		sourceType: 'module',
		lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
	}).program
	return program ? collectImportSpecifiers(program).map(({ specifier }) => specifier) : []
}

type CoreContextPublicEntry = Readonly<{
	createContextHost(
		options: Readonly<{ name: string; capabilities: readonly unknown[] }>,
	): Readonly<{
		createRoot(): unknown
	}>
}>

type CoreContextInternalEntry = Readonly<{
	defineContextCapability(description: string): unknown
	installRootCapability(capability: unknown, options: Readonly<{ create(): unknown }>): unknown
	resolveContextCapability(ctx: unknown, capability: unknown): unknown
}>

function expectCoreContextEntriesToShareOneKernel(
	publicEntry: CoreContextPublicEntry,
	internalEntry: CoreContextInternalEntry,
): void {
	const capability = internalEntry.defineContextCapability('packaging.shared-context-kernel')
	const installation = internalEntry.installRootCapability(capability, {
		create: () => 'shared',
	})
	const host = publicEntry.createContextHost({
		name: 'packaging-shared-kernel',
		capabilities: [installation],
	})
	expect(internalEntry.resolveContextCapability(host.createRoot(), capability)).toBe('shared')
}

describe('toolchain package boundaries', () => {
	it('publishes Context independently while keeping Core self-contained', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '')
		const contextPackageName = ['@pluxel', 'context'].join('/')
		const contextRoot = `${root}/packages/context`
		const coreRoot = `${root}/packages/core`
		const contextManifest = await readJson(`${contextRoot}/package.json`)
		const coreManifest = await readJson(`${coreRoot}/package.json`)
		const contextBuildConfig = await readFile(`${contextRoot}/tsdown.config.ts`, 'utf8')
		const coreBuildConfig = await readFile(`${coreRoot}/tsdown.config.ts`, 'utf8')

		expect(contextManifest.private).not.toBe(true)
		expect(contextManifest).toHaveProperty('license', 'AGPL-3.0-only')
		expect(contextManifest).toHaveProperty('files')
		expect(contextManifest.scripts).toHaveProperty('typecheck')
		expect(
			contextManifest.files?.filter((entry) => !entry.startsWith('!')),
			'Context history must remain outside the published package roots',
		).toEqual(['dist', 'README.md'])
		expect(contextManifest.exports).not.toHaveProperty('./legacy')
		expect(contextManifest.publishConfig.exports).not.toHaveProperty('./legacy')
		expect(contextBuildConfig).not.toContain('legacy')

		const contextProductionFiles = await collectSourceFiles(`${contextRoot}/src`)
		const contextLegacyImports: string[] = []
		for (const file of contextProductionFiles) {
			const specifiers = quotedModuleSpecifiers(await readFile(file, 'utf8'))
			if (specifiers.some((specifier) => /(?:^|\/)legacy(?:\/|$)/.test(specifier))) {
				contextLegacyImports.push(file)
			}
		}
		expect(
			contextLegacyImports,
			'Production Context source must not depend on executable architecture history',
		).toEqual([])

		expect(coreManifest.devDependencies).toHaveProperty(contextPackageName, 'workspace:*')
		for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
			expect(coreManifest[field] ?? {}).not.toHaveProperty(contextPackageName)
		}
		expect(coreManifest.inlinedDependencies).not.toHaveProperty(contextPackageName)
		expect(coreBuildConfig).toContain(
			`alwaysBundle: ['${contextPackageName}', '${contextPackageName}/*']`,
		)
		expect(coreBuildConfig).toContain(
			`conditionNames: ['@pluxel/source', 'import', 'node', 'default']`,
		)
		expect(coreBuildConfig).toMatch(/dts:\s*\{[^}]*eager:\s*true/s)
		expect(coreBuildConfig).not.toMatch(
			new RegExp(`neverBundle:\\s*\\[[^\\]]*${contextPackageName}`),
		)

		const manifestGroups = await Promise.all(
			['packages', 'plugins', 'projects'].map((dir) => collectPackageManifests(`${root}/${dir}`)),
		)
		const manifests = manifestGroups.flat()
		for (const manifestPath of manifests) {
			if (manifestPath === `${contextRoot}/package.json`) continue
			const manifest = await readJson(manifestPath)
			for (const field of [
				'dependencies',
				'devDependencies',
				'peerDependencies',
				'optionalDependencies',
			] as const) {
				if (manifestPath === `${coreRoot}/package.json` && field === 'devDependencies') continue
				expect(
					manifest[field] ?? {},
					`${manifestPath} must not couple to Context unless it owns a Context host`,
				).not.toHaveProperty(contextPackageName)
			}
		}

		const sourceFileGroups = await Promise.all(
			['packages', 'plugins', 'projects'].map((dir) => collectSourceFiles(`${root}/${dir}`)),
		)
		const sourceFiles = sourceFileGroups.flat()
		const sourceLeaks: string[] = []
		for (const file of sourceFiles) {
			if (file.startsWith(`${coreRoot}/`) || file.startsWith(`${contextRoot}/`)) continue
			const source = await readFile(file, 'utf8')
			const quoted = quotedModuleSpecifiers(source)
			if (
				!quoted.some(
					(specifier) =>
						specifier === contextPackageName || specifier.startsWith(`${contextPackageName}/`),
				)
			) {
				continue
			}
			const specifiers = importedModuleSpecifiers(file, source)
			if (
				specifiers.some(
					(specifier) =>
						specifier === contextPackageName || specifier.startsWith(`${contextPackageName}/`),
				)
			) {
				sourceLeaks.push(file)
			}
		}
		expect(sourceLeaks).toEqual([])

		const coreDist = `${coreRoot}/dist`
		if (!existsSync(coreDist)) return
		const distEntries = await readdir(coreDist, { withFileTypes: true, encoding: 'utf8' })
		const distFiles = distEntries
			.filter((entry) => entry.isFile() && /(?:\.mjs|\.cjs|\.d\.mts|\.d\.cts)$/.test(entry.name))
			.map((entry) => join(coreDist, entry.name))
		const distLeaks: string[] = []
		for (const file of distFiles) {
			const specifiers = quotedModuleSpecifiers(await readFile(file, 'utf8'))
			if (
				specifiers.some(
					(specifier) =>
						specifier === contextPackageName || specifier.startsWith(`${contextPackageName}/`),
				)
			) {
				distLeaks.push(file)
			}
		}
		expect(distLeaks, 'Core JS and declarations must inline the Context kernel').toEqual([])

		const esmPublic = (await import(pathToFileURL(`${coreDist}/index.mjs`).href)) as unknown
		const esmInternal = (await import(pathToFileURL(`${coreDist}/internal.mjs`).href)) as unknown
		expectCoreContextEntriesToShareOneKernel(
			esmPublic as CoreContextPublicEntry,
			esmInternal as CoreContextInternalEntry,
		)

		const require = createRequire(import.meta.url)
		const cjsPublic = require(`${coreDist}/index.cjs`) as unknown
		const cjsInternal = require(`${coreDist}/internal.cjs`) as unknown
		expectCoreContextEntriesToShareOneKernel(
			cjsPublic as CoreContextPublicEntry,
			cjsInternal as CoreContextInternalEntry,
		)
	}, 15_000)

	it('prefers community development entries before framework source entries in frontend graphs', () => {
		expect(buildPluxelFrontendResolveConditions('development').slice(0, 2)).toEqual([
			'development',
			'@pluxel/source',
		])
	})

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
		expect(runtimeDynamic.exports).toHaveProperty('./source-producer')
		expect(runtimeDynamic.exports).not.toHaveProperty('./services')
		expect(existsSync(`${root}/packages/runtime-dynamic/src/services.ts`)).toBe(false)
		expect(runtimeStatic.exports).toHaveProperty('./vite')
		expect(runtimeStatic.exports).not.toHaveProperty('./hmr')
		expect(rolldown.exports).toHaveProperty('./vite')
		expect(rolldown.exports).toHaveProperty('./build')
		expect(rolldown.exports).toHaveProperty('./distribution')
		expect(Object.hasOwn(rolldown.exports ?? {}, '.')).toBe(false)
		expect(rolldown.exports).not.toHaveProperty('./workspace')
		expect(rolldown.types).toBeUndefined()
		expect(Object.hasOwn(rolldown.publishConfig?.exports ?? {}, '.')).toBe(false)
		expect(rolldown.publishConfig?.exports).not.toHaveProperty('./workspace')
		expect(existsSync(`${root}/packages/rolldown/src/index.ts`)).toBe(false)
		expect(existsSync(`${root}/packages/rolldown/src/workspace/index.ts`)).toBe(false)
		expect(rolldown.exports).toHaveProperty('./distribution/schema.json')
		expect(rolldown.exports).toHaveProperty('./vite/environment')
		expect(rolldown.exports).toHaveProperty('./resolver/oxc')
		expect(rolldown.exports).toHaveProperty('./workbench/artifact')

		for (const pkg of [runtimeDynamic, runtimeStatic, runtimeDev]) {
			expect(pkg.dependencies).not.toHaveProperty('vite')
			expect(pkg.devDependencies).toHaveProperty('vite')
			expect(pkg.peerDependencies).toHaveProperty('vite', '>=8.2.2 <9')
			expect(pkg.peerDependenciesMeta?.vite?.optional).toBe(true)
		}
		for (const pkg of [runtimeDynamic, runtimeStatic]) {
			expect(pkg.dependencies).not.toHaveProperty('@pluxel/runtime-dev')
			expect(pkg.devDependencies).toHaveProperty('@pluxel/runtime-dev')
		}
	})

	it('keeps static declaration validation on a narrow route-to-toolchain boundary', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const rolldownManifest = await readJson(`${root}/packages/rolldown/package.json`)
		const viteBarrel = await readFile(`${root}/packages/rolldown/src/vite/index.ts`, 'utf8')
		const staticVite = await readFile(`${root}/packages/runtime-static/src/vite.ts`, 'utf8')
		const subpath = './internal/static-config-environment-vite'

		expect(rolldownManifest.exports).toHaveProperty(subpath)
		expect(rolldownManifest.publishConfig?.exports).toHaveProperty(subpath)
		expect(viteBarrel).not.toContain('static-config-environment')
		expect(staticVite).toContain("from '@pluxel/rolldown/internal/static-config-environment-vite'")
		expect(staticVite).not.toContain('../../rolldown/src/')
	})

	it('keeps the Vite Node carrier on current source without leaking that bridge into builds', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const carrier = await readFile(`${root}/packages/runtime-dev/src/vite-node-carrier.ts`, 'utf8')
		const buildConfig = await readFile(`${root}/packages/runtime-dev/tsdown.config.ts`, 'utf8')
		const sourceBridge = await readFile(
			`${root}/packages/runtime-dev/tsdown-source-bridge.ts`,
			'utf8',
		)

		expect(carrier).toContain("from '../../runtime-node/src/index.ts'")
		expect(carrier).not.toContain("from '@pluxel/runtime-node'")
		expect(buildConfig).toContain('pluxelRuntimeNodeSourceBridgeExternal()')
		expect(sourceBridge).toContain("return { id: '@pluxel/runtime-node', external: true }")
	})

	it('keeps Vite and Module Federation lazy behind Workbench UI declarations', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const pluginCode = await readFile(
			`${root}/packages/rolldown/src/plugin-artifact/pluginArtifactBuildPlugin.ts`,
			'utf8',
		)
		const semanticLowering = await readFile(
			`${root}/packages/rolldown/src/workbench/semantic-lowering.ts`,
			'utf8',
		)

		expect(pluginCode).toContain("import('../vite/workbench-ui.ts')")
		expect(semanticLowering).toContain("from './build-contract.ts'")
		expect(pluginCode).not.toMatch(/import\s+\{[^}]*buildWorkbenchUiRemote[^}]*\}\s+from/)
		expect(pluginCode).not.toContain('@module-federation/vite')
	})

	it('keeps workbench UI Module Federation build logic and direct deps in one place', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDynamicFiles = await collectSourceFiles(`${root}/packages/runtime-dynamic/src`)
		const runtimeDevFiles = await collectSourceFiles(`${root}/packages/runtime-dev/src`)
		const rolldown = await readJson(`${root}/packages/rolldown/package.json`)
		const runtime = await readJson(`${root}/packages/runtime/package.json`)
		const workspace = await readFile(`${root}/pnpm-workspace.yaml`, 'utf8')
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
		expect(runtimeStatic.dependencies).toHaveProperty('pathe', 'catalog:node')
		expect(runtimeStatic.dependencies).not.toHaveProperty('typescript')
		expect(runtimeStatic.dependencies).not.toHaveProperty('nf3')
		expect(runtimeStatic.dependencies).not.toHaveProperty('unplugin-macros')
		expect(runtimeStaticTsdown).not.toContain('@module-federation/vite')
		expect(runtimeStaticTsdown).not.toContain('oxc-parser')
		expect(runtimeStaticTsdown).not.toContain('oxc-resolver')
		expect(runtimeStaticTsdown).not.toContain('typescript')
		expect(rolldown.dependencies?.['@module-federation/vite']).toBe('catalog:build')
		expect(rolldown.dependencies?.['@module-federation/bridge-react']).toBe('catalog:frontend')
		expect(runtime.dependencies?.['@module-federation/runtime']).toBe('catalog:prod')
		expect(runtime.dependencies?.['@module-federation/bridge-react']).toBe('catalog:frontend')
		expect(runtime.peerDependencies?.['@mantine/core']).toBe('catalog:frontend')
		expect(runtime.peerDependencies?.['@mantine/hooks']).toBe('catalog:frontend')
		expect(workspace).toContain(
			`  '@module-federation/vite': ${WORKBENCH_FEDERATION_VITE_VERSION}\n`,
		)
		expect(workspace).toContain(
			`  '@module-federation/bridge-react': ${WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION}\n`,
		)
		expect(workspace).toContain(
			`  '@module-federation/runtime': ${WORKBENCH_FEDERATION_RUNTIME_VERSION}\n`,
		)
		expect(workspace).toContain(`  '@mantine/core': ^${WORKBENCH_FEDERATION_MANTINE_VERSION}\n`)
		expect(workspace).toContain(`  '@mantine/hooks': ^${WORKBENCH_FEDERATION_MANTINE_VERSION}\n`)
	})

	it('keeps Rolldown plugin utility dependencies inside the rolldown package', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDynamic = await readJson(`${root}/packages/runtime-dynamic/package.json`)

		expect(runtimeDynamic.dependencies).not.toHaveProperty('@rolldown/pluginutils')
	})

	it('keeps the dynamic source-producer contract isolated from route and producer machinery', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const source = await readFile(`${root}/packages/runtime-dynamic/src/source-producer.ts`, 'utf8')
		expect(source).toContain("import { resolve } from 'node:path'")
		expect(source).toContain("import type { Context } from '@pluxel/core'")
		expect(source).toContain("import type { DynamicPluginSource } from './sources'")

		const forbidden = [
			"from 'vite'",
			'chokidar',
			'picomatch',
			'LoaderHmrService',
			'PackageManager',
			'@pnpm/napi',
		]
		for (const token of forbidden) expect(source).not.toContain(token)

		const built = `${root}/packages/runtime-dynamic/dist/source-producer.mjs`
		const builtCode = existsSync(built) ? await readFile(built, 'utf8') : ''
		for (const token of forbidden) expect(builtCode).not.toContain(token)
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
			...(await collectSourceFiles(`${root}/projects/plugin-host/src/demo`)),
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
			...(await collectSourceFiles(`${root}/projects/plugin-host/src`)),
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
		const staticDeclaration = await readFile(
			`${root}/packages/rolldown/src/rolldown/plugins/staticConfigEnvironment.ts`,
			'utf8',
		)
		const pluginBuild = await readFile(`${root}/packages/rolldown/src/cli/plugin-build.ts`, 'utf8')
		const cliBuild = await readFile(`${root}/packages/cli/src/commands/build.ts`, 'utf8')
		const runtimeDevVite = await readFile(`${root}/packages/runtime-dev/src/vite.ts`, 'utf8')
		const viteSource = await readFile(`${root}/packages/rolldown/src/vite/plugin-source.ts`, 'utf8')
		const nodeWorkbenchApplication = await readFile(
			`${root}/packages/runtime-static/src/internal/node-workbench-application.ts`,
			'utf8',
		)
		const staticHost = await readFile(
			`${root}/packages/runtime-static/src/internal/host.ts`,
			'utf8',
		)
		const staticHostRuntimeEntry = await readFile(
			`${root}/packages/runtime/src/internal-static-host.ts`,
			'utf8',
		)

		expect(buildEntry).toContain("export * from './static-application'")
		expect(runtimeStatic.exports).toHaveProperty('./internal/node-application')
		expect(runtimeStatic.exports).toHaveProperty('./internal/node-workbench-application')
		expect(runtime.exports).toHaveProperty('./internal/static-host')
		expect(nodeWorkbenchApplication).toContain('@pluxel/runtime/internal/static')
		expect(staticHost).toContain('@pluxel/runtime/internal/static-host')
		expect(staticHost).toContain('installRuntimePluginGraphCoordinator')
		expect(staticHost).not.toMatch(/export\s+(?:type\s+)?\*\s+from/)
		expect(staticHostRuntimeEntry).toContain("from './services/RuntimeStateHelpers'")
		expect(staticHostRuntimeEntry).toContain("from './runtime/capabilities'")
		expect(staticHostRuntimeEntry).not.toContain("from './runtime/module-id'")
		expect(staticHostRuntimeEntry).not.toContain("from './shared'")
		expect(freezer).toContain('export function staticApplication(')
		expect(freezer).toContain("await import('nf3')")
		expect(freezer).toContain('createPluginBuildPipeline({')
		expect(freezer).not.toContain('pluginArtifactBuildPlugin(')
		expect(freezer).not.toContain('configSourcePlugin()')
		expect(freezer).not.toContain('lintGuardPlugin(')
		expect(freezer).toContain('staticConfigEnvironmentDeclarationPlugin')
		expect(staticDeclaration).toContain('must default-export defineStaticRuntime(...) directly')
		expect(pluginBuild).toContain('export function pluginPackage(')
		expect(pluginBuild).toContain('export function createPluginBuildPipeline(')
		expect(pluginBuild).toContain("from 'unplugin-macros/rolldown'")
		expect(pluginBuild).toContain("from 'unplugin-preprocessor-directives/rollup'")
		expect(pluginBuild).toContain('lintGuardPlugin(')
		expect(pluginBuild).toContain('configSourcePlugin()')
		expect(pluginBuild).toContain('pluginArtifactBuildPlugin(')
		expect(pluginBuild).toContain('legacy: true')
		expect(pluginBuild).toContain('emitDecoratorMetadata: false')
		expect(pluginBuild).toContain("name: 'pluxel:decorator-output-guard'")
		expect(cliBuild).toContain('build.pluginPackage({')
		expect(cliBuild).not.toContain('configSourcePlugin(')
		expect(cliBuild).not.toContain('pluginArtifactBuildPlugin(')
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
		const files = [...sourceFiles, `${root}/packages/create/template/host/src/pluxel.static.ts`]
		const offenders: string[] = []

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			if (/\.map\(\s*\([^)]*\)\s*=>\s*[^)]*\.name\s*\)/.test(code)) offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps the plugin runtime independent from reflection metadata', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const coreManifest = await readJson(`${root}/packages/core/package.json`)
		const coreBuildConfig = await readFile(`${root}/packages/core/tsdown.config.ts`, 'utf8')
		const runtimePackages = ['core', 'runtime', 'runtime-dev', 'runtime-dynamic', 'runtime-static']
		const packageSourceFiles = await Promise.all(
			runtimePackages.map((name) => collectSourceFiles(`${root}/packages/${name}/src`)),
		)
		const sourceFiles = packageSourceFiles.flat()
		const offenders: string[] = []

		for (const file of sourceFiles) {
			const code = await readFile(file, 'utf8')
			if (code.includes('@abraham/reflection')) offenders.push(file)
			if (code.includes('design:paramtypes')) offenders.push(file)
		}

		expect(existsSync(`${root}/packages/core/src/reflection.ts`)).toBe(false)
		expect(coreManifest.dependencies).not.toHaveProperty('@abraham/reflection')
		expect(coreManifest.devDependencies).not.toHaveProperty('@abraham/reflection')
		expect(coreManifest.inlinedDependencies).not.toHaveProperty('@abraham/reflection')
		expect(coreBuildConfig).not.toContain('@abraham/reflection')
		expect(offenders).toEqual([])

		for (const packageName of runtimePackages) {
			const config = await readJson(`${root}/packages/${packageName}/tsconfig.json`)
			expect(config.compilerOptions).not.toHaveProperty('emitDecoratorMetadata')
		}
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

		expect(runtimeDevWorkbench).toContain('export function attachPluginArtifactCompiler(')
		expect(runtimeDevWorkbench).toContain('new PluginArtifactCompiler(')
		expect(runtimeDevWorkbench).toContain('publishWorkbenchProducers:')
		expect(runtimeDevWorkbench).not.toContain('artifacts?.attachSourceBinder(')
		expect(runtimeDevWorkbench).toContain('ctx.nodeModules.attachSourceBinder(')
		expect(runtimeDevWorkbench).not.toContain('ctx.runtimeDev =')
		expect(runtimeCapabilities).not.toContain('workbenchUiSource')
		expect(workbenchService).not.toContain('interface WorkbenchBackend')
		expect(staticVite).toContain('runtimeDev.attachPluginArtifactCompiler(ctx,')
		expect(staticVite).not.toContain('new runtimeDev.PluginArtifactCompiler(')
		expect(dynamicHost).toContain('attachPluginArtifactCompiler(ctx,')
		expect(dynamicHost).not.toContain('new PluginArtifactCompiler(')
	})

	it('keeps dev/HMR capabilities out of the runtime route contract', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const capabilities = await readFile(
			`${root}/packages/runtime/src/runtime/capabilities.ts`,
			'utf8',
		)
		const runtimePackage = JSON.parse(
			await readFile(`${root}/packages/runtime/package.json`, 'utf8'),
		) as { exports?: Record<string, unknown> }

		const routeType = capabilities.match(
			/export type RuntimeRouteCapabilities = \{[\s\S]*?\n\}/,
		)?.[0]
		expect(routeType).toBeTruthy()
		expect(routeType).not.toContain('dev?:')
		expect(capabilities).not.toContain('RuntimeDevCapabilities')
		expect(capabilities).not.toContain('RuntimeWorkerWatchOptions')
		expect(capabilities).not.toMatch(/\bworker\?:\s*\{/)
		expect(runtimePackage.exports).not.toHaveProperty('./plugin')
		for (const subpath of [
			'./api',
			'./shared',
			'./plugin-catalog',
			'./runtime-state',
			'./protocol',
		]) {
			expect(runtimePackage.exports).not.toHaveProperty(subpath)
		}
		expect(existsSync(`${root}/packages/runtime/src/protocol.ts`)).toBe(false)
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
			'picomatch',
			'@pluxel/runtime-dynamic',
			'PackageManager',
			'@pnpm/napi',
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
