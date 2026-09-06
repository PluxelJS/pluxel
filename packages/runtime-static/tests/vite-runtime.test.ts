import { execFile } from 'node:child_process'
import { mkdir, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const runner = fileURLToPath(new URL('./support/vite-runtime-runner.mts', import.meta.url))

describe('static Vite runtime', () => {
	it('consumes package-root lowering across built toolchain/runtime packages', async () => {
		await using fixture = await createDiskFixture(
			{ 'pnpm-workspace.yaml': 'packages: []\n' },
			{ tempDir: resolve(workspaceRoot, 'packages/runtime-static/tests') },
		)
		const entryPath = fixture.getPath('pluxel.static.ts')
		const pluginPath = fixture.getPath('packages/vite-static/src/index.ts')
		const pluginRoot = fixture.getPath('packages/vite-static')
		const pluginLink = fixture.getPath('node_modules/@fixture/vite-static')
		const builtPluginRoot = fixture.getPath('packages/vite-built')
		const builtPluginLink = fixture.getPath('node_modules/@fixture/vite-built')
		await mkdir(fixture.getPath('packages/vite-static/src'), { recursive: true })
		await mkdir(fixture.getPath('packages/vite-built/dist'), { recursive: true })
		await fixture.writeFile(
			'packages/vite-static/package.json',
			JSON.stringify({
				name: '@fixture/vite-static',
				type: 'module',
				exports: {
					'.': {
						'@pluxel/hmr': './src/index.ts',
						default: './dist/index.mjs',
					},
				},
			}),
		)
		await fixture.writeFile('packages/vite-static/src/index.ts', pluginSource('v1', true))
		await fixture.writeFile(
			'packages/vite-built/package.json',
			JSON.stringify({
				name: '@fixture/vite-built',
				type: 'module',
				exports: { '.': './dist/index.mjs' },
			}),
		)
		await fixture.writeFile('packages/vite-built/dist/index.mjs', builtPluginSource())
		await mkdir(fixture.getPath('node_modules/@fixture'), { recursive: true })
		await symlink(pluginRoot, pluginLink, 'dir')
		await symlink(builtPluginRoot, builtPluginLink, 'dir')
		await fixture.writeFile(
			'pluxel.static.ts',
			[
				"import { pluginNodeAddressOf } from '@pluxel/runtime'",
				"import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'",
				"import { ConfiguredPlugin, ConfiguredPluginConfig, PartOwner, PartProvider, runtimePlugins, ViteStatic } from '@fixture/vite-static'",
				'export default defineStaticRuntime({',
				"  name: 'static-vite-smoke',",
				'  plugins: runtimePlugins,',
				'  configEnvironmentBootstrap: [',
				"    bindConfigEnvironment(ConfiguredPlugin, ConfiguredPluginConfig, { label: 'VITE_STATIC_LABEL' }),",
				'  ],',
				'  configure() {',
				'    const implementation = runtimePlugins[0]',
				'    const defaultNode = implementation ? pluginNodeAddressOf(implementation) : undefined',
				'    const configuredNode = pluginNodeAddressOf(ConfiguredPlugin)',
				'    const partProviderNode = pluginNodeAddressOf(PartProvider)',
				'    const partOwnerNode = pluginNodeAddressOf(PartOwner)',
				'    const definition = defaultNode?.definition',
				"    const east = definition ? { definition, variant: 'fork', forkId: 'east' } : undefined",
				"    const west = definition ? { definition, variant: 'fork', forkId: 'west' } : undefined",
				'    return {',
				'      workbench: false,',
				'      logging: false,',
				"      configService: { mode: 'memory' },",
				"      runtimeState: { mode: 'memory', snapshot: {",
				'        autoStart: defaultNode && east && west ? [defaultNode, east, west, configuredNode, partProviderNode, partOwnerNode] : [configuredNode, partProviderNode, partOwnerNode],',
				"        forks: definition ? [{ definition, forkIds: ['east', 'west'] }] : [],",
				'      } },',
				'    }',
				'  },',
				'  prepare({ host, startup }) {',
				'    const capture = startup.bindings.capture',
				"    if (typeof capture === 'function') capture(host, runtimePlugins[0])",
				'  },',
				'})',
				'',
			].join('\n'),
		)

		await expect(
			execFileAsync(process.execPath, ['--import', 'tsx', runner], {
				cwd: resolve(workspaceRoot, 'packages/runtime-static'),
				env: {
					...process.env,
					CI: '1',
					PLUXEL_VITE_SMOKE_ROOT: fixture.path,
					PLUXEL_VITE_SMOKE_ENTRY: entryPath,
					PLUXEL_VITE_SMOKE_PLUGIN: pluginPath,
					PLUXEL_VITE_SMOKE_BUILT_PLUGIN: fixture.getPath(
						'packages/vite-built/dist/index.mjs',
					),
					PLUXEL_VITE_SMOKE_CACHE: fixture.getPath('.vite-cache'),
					VITE_STATIC_LABEL: 'configured-through-vite',
				},
				timeout: 60_000,
			}),
		).resolves.toBeDefined()
	}, 90_000)
})

function pluginSource(version: string, available: boolean): string {
	return [
		"import { BasePlugin, Plugin, PluginPart, v } from '@pluxel/runtime'",
		"import { websocket } from 'elysia/websocket'",
		"import { BuiltStatic } from '@fixture/vite-built'",
		"export const ViteStaticConfig = v.object({ label: v.optional(v.string(), 'default') })",
		"@Plugin({ displayName: 'Vite static', forkable: true })",
		'export class ViteStatic extends BasePlugin {',
		'  private readonly settings = this.configs.use(ViteStaticConfig)',
		`  readonly version = ${JSON.stringify(version)}`,
		"  configuredLabel = ''",
		`  protected override init() { this.configuredLabel = this.settings.label; if (this.ctx.pluginInfo.nodeAddress.variant === 'default') this.ctx.elysia.use(websocket()).get('/vite-static/version', () => ${JSON.stringify(version)}).ws('/vite-static/socket', { open(socket) { socket.send(${JSON.stringify(version)}) } }) }`,
		'}',
		"export const ConfiguredPluginConfig = v.object({ label: v.optional(v.string(), 'default') })",
		'@Plugin()',
		'export class ConfiguredPlugin extends BasePlugin {',
		'  private readonly settings = this.configs.use(ConfiguredPluginConfig)',
		"  configuredLabel = ''",
		`  protected override init() { this.configuredLabel = this.settings.label; this.ctx.elysia.use(websocket()).get('/configured/version', () => ${JSON.stringify(version)}).ws('/configured/socket', { open(socket) { socket.send(${JSON.stringify(version)}) } }) }`,
		'}',
		'@Plugin()',
		'export class PartProvider extends BasePlugin {',
		`  readonly marker = ${JSON.stringify(`part-provider-${version}`)}`,
		'}',
		'class RequiredPart extends PluginPart<PartOwner> {',
		'  constructor(private readonly provider: PartProvider) { super() }',
		'  marker() { return this.provider.marker }',
		'}',
		'@Plugin()',
		'export class PartOwner extends BasePlugin {',
		'  private readonly required = this.parts.use(RequiredPart)',
		"  injected = ''",
		'  protected override init() { this.injected = this.required.marker() }',
		'}',
		`export const runtimePlugins = ${available ? '[ViteStatic, ConfiguredPlugin, PartProvider, PartOwner, BuiltStatic]' : '[ConfiguredPlugin, PartProvider, PartOwner, BuiltStatic]'}`,
		'',
	].join('\n')
}

function builtPluginSource(): string {
	return [
		'// [pluxel-plugin-semantics] Injected facts',
		"import { BasePlugin, Plugin } from '@pluxel/runtime'",
		"import { __setPluginDefinition } from '@pluxel/runtime/toolchain'",
		'class BuiltStatic extends BasePlugin {}',
		"Plugin({ displayName: 'Built static' })(BuiltStatic)",
		'__setPluginDefinition(BuiltStatic, {',
		'  abiVersion: 2,',
		"  kind: 'plugin',",
		"  definition: { entry: { kind: 'package-root', packageName: '@fixture/vite-built' }, exportName: 'BuiltStatic' },",
		'})',
		'export { BuiltStatic }',
		'',
	].join('\n')
}
