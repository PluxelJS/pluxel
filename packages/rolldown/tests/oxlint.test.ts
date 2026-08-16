import { RuleTester } from 'oxlint/plugins-dev'
import { describe, expect, it } from 'vitest'
import {
	createPluxelJsPluginEntry,
	prefixPluxelRuleSet,
	pluxelCorrectnessRuleNames,
	pluxelCorrectnessRules,
	pluxelRulePolicy,
	pluxelRules,
	type OxRule,
} from '../src/workspace/oxlint/index.ts'

RuleTester.describe = describe
RuleTester.it = it

type TestedRule = Parameters<RuleTester['run']>[1]
type TestedCases = Parameters<RuleTester['run']>[2]

const WORKSPACE_PLUGIN_SPECIFIER = './packages/rolldown/src/workspace/oxlint/plugin.ts'

const tester = new RuleTester({
	languageOptions: {
		sourceType: 'module',
		parserOptions: { lang: 'ts' },
	},
})

function runRule(name: string, rule: OxRule, tests: TestedCases) {
	tester.run(name, rule as unknown as TestedRule, tests)
}

runRule('log-no-rendered-error', pluxelRules['log-no-rendered-error'], {
	valid: [
		{ code: "logger.error('failed', { error })" },
		{ code: 'logger.error((l) => l`failed ${label}`)' },
		{ code: "logger.with({ error }).error('failed')" },
	],
	invalid: [
		{
			code: "logger.error('failed: {error}', { error })",
			errors: [{ messageId: 'placeholder' }],
		},
		{
			code: 'logger.warn(`failed ${error}`)',
			errors: [{ messageId: 'rendered' }],
		},
		{
			code: "logger.error('failed: ' + String(error))",
			errors: [{ messageId: 'rendered' }],
		},
		{
			code: 'logger.fatal`failed ${error}`',
			errors: [{ messageId: 'rendered' }],
		},
	],
})

runRule('log-canonical-error-prop', pluxelRules['log-canonical-error-prop'], {
	valid: [
		{ code: "logger.error('failed', { error })" },
		{ code: 'logger.warn({ err })' },
		{ code: "logger.with({ error }).error('failed')" },
		{ code: "logger.error('failed', () => ({ error, debug: details() }))" },
	],
	invalid: [
		{
			code: "logger.error('failed', { exception: error })",
			output: "logger.error('failed', { error: error })",
			errors: [
				{
					messageId: 'alias',
					suggestions: [
						{ messageId: 'renameToError', output: "logger.error('failed', { error: error })" },
					],
				},
			],
		},
		{
			code: 'logger.warn({ error, err })',
			errors: [{ messageId: 'duplicate' }],
		},
		{
			code: "logger.with({ cause: error }).error('failed')",
			output: "logger.with({ error: error }).error('failed')",
			errors: [
				{
					messageId: 'alias',
					suggestions: [
						{ messageId: 'renameToError', output: "logger.with({ error: error }).error('failed')" },
					],
				},
			],
		},
		{
			code: "logger.warn('failed', { reason: err })",
			output: "logger.warn('failed', { err: err })",
			errors: [
				{
					messageId: 'alias',
					suggestions: [
						{ messageId: 'renameToErr', output: "logger.warn('failed', { err: err })" },
					],
				},
			],
		},
		{
			code: "logger.error('failed', { error: String(error) })",
			errors: [{ messageId: 'raw' }],
		},
	],
})

runRule('configs-use-top-level-class', pluxelRules['configs-use-top-level-class'], {
	valid: [
		{
			filename: '/repo/projects/plugin-host/src/demo/PluginA.ts',
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
				}
			`,
		},
		{
			filename: '/repo/projects/plugin-host/src/demo/PluginB.ts',
			code: `
				const PluginB = class extends BasePlugin {
					config = this.configs.use(ConfigSchema)
				}
			`,
		},
	],
	invalid: [
		{
			filename: '/repo/packages/core/tests/example.test.ts',
			code: `
				function makePlugin() {
					return class extends BasePlugin {
						config = this.configs.use(ConfigSchema)
					}
				}
			`,
			errors: [{ messageId: 'topLevel' }],
		},
	],
})

runRule('configs-use-no-private-field', pluxelRules['configs-use-no-private-field'], {
	valid: [
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
				}
			`,
		},
	],
	invalid: [
		{
			code: `
				class PluginA extends BasePlugin {
					#config = this.configs.use(ConfigSchema)
				}
			`,
			errors: [{ messageId: 'privateField' }],
		},
	],
})

runRule('configs-use-no-early-read', pluxelRules['configs-use-no-early-read'], {
	valid: [
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					override init() {
						return this.config
					}
				}
			`,
		},
	],
	invalid: [
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					ready = this.config
				}
			`,
			errors: [{ messageId: 'earlyRead' }],
		},
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					constructor() {
						super()
						void this.config
					}
				}
			`,
			errors: [{ messageId: 'earlyRead' }],
		},
	],
})

runRule('configs-use-no-redefault', pluxelRules['configs-use-no-redefault'], {
	valid: [
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					override init() {
						return this.config
					}
				}
			`,
		},
	],
	invalid: [
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					override init() {
						return this.config ?? {}
					}
				}
			`,
			output: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					override init() {
						return this.config
					}
				}
			`,
			errors: [{ messageId: 'redefault' }],
		},
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					override init() {
						return this.config || {}
					}
				}
			`,
			errors: [{ messageId: 'redefault' }],
		},
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					override init() {
						return (this.config ??= {})
					}
				}
			`,
			output: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
					override init() {
						return (this.config)
					}
				}
			`,
			errors: [{ messageId: 'redefault' }],
		},
	],
})

runRule('plugin-no-process-exit', pluxelRules['plugin-no-process-exit'], {
	valid: [
		{
			code: `
				process.exit(1)
			`,
		},
		{
			code: `
				class HostEntrypoint {
					stop() {
						process.exit(1)
					}
				}
			`,
		},
		{
			code: `
				@Plugin({ displayName: 'Plugin P' })
				class P extends BasePlugin {
					override init() {
						throw new Error('not ready')
					}
				}
			`,
		},
	],
	invalid: [
		{
			code: `
				@Plugin({ displayName: 'Plugin P' })
				class P extends BasePlugin {
					override init() {
						process.exit(1)
					}
				}
			`,
			errors: [{ messageId: 'exit' }],
		},
		{
			code: `
				@Plugin({ displayName: 'Plugin P' })
				class P extends BasePlugin {
					override init() {
						setTimeout(() => process.exit(1), 10)
					}
				}
			`,
			errors: [{ messageId: 'exit' }],
		},
	],
})

runRule('no-direct-logtape-get-logger', pluxelRules['no-direct-logtape-get-logger'], {
	valid: [
		{
			filename: '/repo/packages/core/src/logger/debug.ts',
			code: "import { getLogger } from '@logtape/logtape'",
		},
		{
			filename: '/repo/packages/runtime/src/services/Foo.ts',
			code: "import type { Logger } from '@logtape/logtape'",
		},
	],
	invalid: [
		{
			filename: '/repo/packages/runtime/src/services/Foo.ts',
			code: "import { getLogger } from '@logtape/logtape'",
			errors: [{ messageId: 'direct' }],
		},
	],
})

runRule('no-workspace-root-import', pluxelRules['no-workspace-root-import'], {
	valid: [
		{
			filename: '/repo/packages/runtime-dynamic/src/scan/fs.ts',
			code: "import { crawlFilesAbs } from '@pluxel/rolldown/workspace/fs'",
		},
		{
			filename: '/repo/packages/runtime/vite.config.ts',
			code: "import { createPluxelUiChunkGroups } from '@pluxel/rolldown/workspace/vite'",
		},
		{
			filename: '/repo/packages/rolldown/src/workspace/index.ts',
			code: "export * from '@pluxel/rolldown/workspace'",
		},
	],
	invalid: [
		{
			filename: '/repo/packages/runtime-dynamic/src/scan/fs.ts',
			code: "import { crawlFilesAbs } from '@pluxel/rolldown/workspace'",
			errors: [{ messageId: 'root' }],
		},
		{
			filename: '/repo/packages/cli/src/workspace/state.ts',
			code: "export { loadWorkspaceInfo } from '@pluxel/rolldown/workspace'",
			errors: [{ messageId: 'root' }],
		},
		{
			filename: '/repo/packages/runtime-dynamic/src/hmr/diagnose/fs.ts',
			code: "export * from '@pluxel/rolldown/workspace'",
			errors: [{ messageId: 'root' }],
		},
		{
			filename: '/repo/packages/runtime-dynamic/src/package/PackageService.ts',
			code: "await import('@pluxel/rolldown/workspace')",
			errors: [{ messageId: 'root' }],
		},
	],
})

runRule(
	'plugin-base-class-requires-plugin-registration',
	pluxelRules['plugin-base-class-requires-plugin-registration'],
	{
		valid: [
			{
				code: `
					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {}
				`,
			},
			{
				code: `
					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends ForkablePlugin {}
				`,
			},
			{
				code: `
					abstract class PluginBase extends BasePlugin {}
				`,
			},
			{
				code: `
					@runtime.Plugin({ displayName: 'Plugin A' })
					class PluginA extends runtime.BasePlugin {}
				`,
			},
		],
		invalid: [
			{
				code: `
					class PluginA extends BasePlugin {}
				`,
				errors: [{ messageId: 'missing' }],
			},
			{
				code: `
					class PluginA extends ForkablePlugin {}
				`,
				errors: [{ messageId: 'missing' }],
			},
			{
				code: `
					export class PluginA extends runtime.BasePlugin {}
				`,
				errors: [{ messageId: 'missing' }],
			},
			{
				code: `
					class PluginA extends BasePlugin {}
					Plugin({ displayName: 'Plugin A' })(PluginA)
				`,
				errors: [{ messageId: 'missing' }],
			},
		],
	},
)

runRule(
	'plugin-constructor-canonical-dependencies',
	pluxelRules['plugin-constructor-canonical-dependencies'],
	{
		valid: [
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					import { PluginB } from '@pluxel/plugin-b'

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(pluginB: PluginB) {
							super()
							void pluginB
						}
					}
				`,
			},
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					import { PluginB as Dependency } from '@pluxel/plugin-b'

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(dependency: Dependency) {
							super()
							void dependency
						}
					}
				`,
			},
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					abstract class PluginBackend extends BasePlugin {}

					@Plugin({ displayName: 'Plugin B' })
					class PluginB extends BasePlugin {}

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(backend: PluginBackend, pluginB: PluginB) {
							super()
							void backend
							void pluginB
						}
					}
				`,
			},
			{
				filename: '/repo/packages/core/tests/helper.ts',
				code: `
					import type { PluginB } from './PluginB'

					class Helper {
						constructor(pluginB: PluginB) {
							void pluginB
						}
					}
				`,
			},
		],
		invalid: [
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					import type { PluginB } from '@pluxel/plugin-b'

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(pluginB: PluginB) {
							super()
							void pluginB
						}
					}
				`,
				errors: [{ messageId: 'typeOnly' }],
			},
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					import { PluginB } from '@pluxel/plugin-b/backend'

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(pluginB: PluginB) {
							super()
							void pluginB
						}
					}
				`,
				errors: [{ messageId: 'subpath' }],
			},
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					import { PluginB } from '@pluxel/plugin-b'
					type Dependency = PluginB

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(dependency: Dependency) {
							super()
							void dependency
						}
					}
				`,
				errors: [{ messageId: 'unprovable' }],
			},
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					import { PluginB } from '@pluxel/plugin-b'
					import { PluginC } from '@pluxel/plugin-c'

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(dependency: PluginB | PluginC) {
							super()
							void dependency
						}
					}
				`,
				errors: [{ messageId: 'unprovable' }],
			},
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					interface PluginDependency {}

					@Plugin({ displayName: 'Plugin A' })
					class PluginA extends BasePlugin {
						constructor(dependency: PluginDependency) {
							super()
							void dependency
						}
					}
				`,
				errors: [{ messageId: 'unprovable' }],
			},
		],
	},
)

runRule('plugin-no-removed-feature-api', pluxelRules['plugin-no-removed-feature-api'], {
	valid: [
		{
			code: `
				class CacheCatalog {
					load() {}
				}
			`,
		},
	],
	invalid: [
		{
			code: 'class CacheFeature extends BaseFeature {}',
			errors: [{ messageId: 'removed' }],
		},
		{
			code: "const lazy = defineLazyFeature({ load: () => import('./cache') })",
			errors: [{ messageId: 'removed' }],
		},
		{
			code: 'this.features.use(CacheFeature)',
			errors: [{ messageId: 'removed' }],
		},
	],
})

runRule('configs-use-single-object-schema', pluxelRules['configs-use-single-object-schema'], {
	valid: [
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(v.object({ enabled: v.boolean() }))
				}
			`,
		},
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(ConfigSchema)
				}
			`,
		},
	],
	invalid: [
		{
			code: `
				class PluginA extends BasePlugin {
					server = this.configs.use(ServerSchema)
					client = this.configs.use(ClientSchema)
				}
			`,
			errors: [{ messageId: 'multiple' }, { messageId: 'multiple' }],
		},
		{
			code: `
				class PluginA extends BasePlugin {
					config = this.configs.use(v.string())
				}
			`,
			errors: [{ messageId: 'nonObject' }],
		},
	],
})

runRule('configs-no-removed-dsl', pluxelRules['configs-no-removed-dsl'], {
	valid: [
		{ code: 'const config = this.configs.use(ConfigSchema)' },
		{ code: 'host.cfg(PluginA).set({ enabled: true })' },
	],
	invalid: [
		{
			code: `
				@Config({ key: 'enabled' })
				class PluginConfig {}
			`,
			errors: [{ messageId: 'removed' }],
		},
		{
			code: "const schema = cfg('PluginA', { enabled: true })",
			errors: [{ messageId: 'removed' }],
		},
	],
})

describe('pluxel correctness helpers', () => {
	it('keeps build enforcement sourced from the correctness rule set', () => {
		expect(Object.keys(pluxelRulePolicy).sort()).toEqual(Object.keys(pluxelRules).sort())
		expect(Object.keys(pluxelCorrectnessRules).sort()).toEqual(
			[...pluxelCorrectnessRuleNames].sort(),
		)
		expect(
			Object.entries(pluxelRulePolicy)
				.filter(([, policy]) => policy.buildCritical)
				.map(([name]) => name)
				.sort(),
		).toEqual([...pluxelCorrectnessRuleNames].sort())
		expect(createPluxelJsPluginEntry(WORKSPACE_PLUGIN_SPECIFIER)).toEqual({
			name: 'pluxel',
			specifier: WORKSPACE_PLUGIN_SPECIFIER,
		})
		expect(prefixPluxelRuleSet(pluxelCorrectnessRules)).toEqual(
			Object.fromEntries(pluxelCorrectnessRuleNames.map((name) => [`pluxel/${name}`, 'error'])),
		)
	})
})
