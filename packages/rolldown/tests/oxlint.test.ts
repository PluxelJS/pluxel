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

runRule('features-use-top-level-class', pluxelRules['features-use-top-level-class'], {
	valid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {
					cache = this.features.use(CacheFeature)
				}
			`,
		},
	],
	invalid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				function makePlugin() {
					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						cache = this.features.use(CacheFeature)
					}
					return PluginA
				}
			`,
			errors: [{ messageId: 'topLevel' }],
		},
	],
})

runRule('features-load-no-class-field', pluxelRules['features-load-no-class-field'], {
	valid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
				})

				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {
					feature

					override async init() {
						this.feature = await this.features.load(optionalFeature)
					}
				}
			`,
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
				})

				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {
					constructor() {
						super()
						const activateLater = async () =>
							this.features.load(optionalFeature)
						void activateLater
					}
				}
			`,
		},
	],
	invalid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
				})

				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {
					feature = this.features.load(optionalFeature)
				}
			`,
			errors: [{ messageId: 'classField' }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
				})

				@Plugin({ name: 'PluginA' })
				class PluginA extends BasePlugin {
					constructor() {
						super()
						void this.features.load(optionalFeature)
					}
				}
			`,
			errors: [{ messageId: 'constructor' }],
		},
	],
})

runRule('features-load-requires-defined-spec', pluxelRules['features-load-requires-defined-spec'], {
	valid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
					const optionalFeature = defineLazyFeature({
						key: 'optional',
						load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
					})

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						override async init() {
							await this.features.load(optionalFeature)
						}
					}
				`,
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
					import { optionalFeature } from './optional-spec'

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						override async init() {
							await this.features.load(optionalFeature)
						}
					}
				`,
		},
	],
	invalid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						override async init() {
							await this.features.load({
								key: 'optional',
								load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
							})
						}
					}
				`,
			errors: [{ messageId: 'inlineSpec' }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
					let optionalFeature = defineLazyFeature({
						key: 'optional',
						load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
					})

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						override async init() {
							await this.features.load(optionalFeature)
						}
					}
				`,
			errors: [{ messageId: 'mutableSpec' }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
					const optionalFeature = {
						key: 'optional',
						load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
					}

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						override async init() {
							await this.features.load(optionalFeature)
						}
					}
				`,
			errors: [{ messageId: 'invalidSpec' }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
					const optionalFeature = defineLazyFeature({
						key: 'optional',
						load: () => import('./optional').then(({ OptionalFeature }) => OptionalFeature),
					})

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						override async init() {
							await this.features.load(optionalFeature, 'legacy')
						}
					}
				`,
			errors: [{ messageId: 'extraArgs' }],
		},
	],
})

runRule('features-load-no-static-load', pluxelRules['features-load-no-static-load'], {
	valid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: () =>
						import('./optional').then(
							({ OptionalFeature }) => OptionalFeature,
						),
				})
			`,
		},
	],
	invalid: [
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				import { OptionalFeature } from './optional'

				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: async () => OptionalFeature,
				})
			`,
			errors: [{ messageId: 'staticLoad', data: { name: 'OptionalFeature' } }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				import * as optionalModule from './optional'

				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load() {
						return optionalModule.OptionalFeature
					},
				})
			`,
			errors: [{ messageId: 'staticLoad', data: { name: 'optionalModule' } }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				class OptionalFeature extends BaseFeature {}

				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: async () => OptionalFeature,
				})
			`,
			errors: [{ messageId: 'staticLoad', data: { name: 'OptionalFeature' } }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				import { OptionalFeature } from './optional'

				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: async () => {
						await import('./optional')
						return OptionalFeature
					},
				})
			`,
			errors: [{ messageId: 'staticLoad', data: { name: 'OptionalFeature' } }],
		},
		{
			filename: '/repo/packages/core/tests/plugin-a.ts',
			code: `
				const optionalFeature = defineLazyFeature({
					key: 'optional',
					load: async () => {
						await Promise.resolve()
					},
				})
			`,
			errors: [{ messageId: 'noDynamicImport' }],
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
				@Plugin({ name: 'P' })
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
				@Plugin({ name: 'P' })
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
				@Plugin({ name: 'P' })
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
					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {}
				`,
			},
			{
				code: `
					@Plugin({ name: 'PluginA' })
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
					class PluginA extends BasePlugin {}
					Plugin({ name: 'PluginA' })(PluginA)
				`,
			},
			{
				code: `
					const PluginA = class extends BasePlugin {}
					Plugin({ name: 'PluginA' })(PluginA)
				`,
			},
			{
				code: `
					class PluginA extends runtime.BasePlugin {}
					runtime.Plugin({ name: 'PluginA' })(PluginA)
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
					const PluginA = class extends BasePlugin {}
				`,
				errors: [{ messageId: 'missing' }],
			},
		],
	},
)

runRule(
	'plugin-constructor-no-type-only-imports',
	pluxelRules['plugin-constructor-no-type-only-imports'],
	{
		valid: [
			{
				filename: '/repo/packages/core/tests/plugin-a.ts',
				code: `
					import { PluginB } from './PluginB'

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						constructor(pluginB: PluginB) {
							super()
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
					import type { PluginB } from './PluginB'

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						constructor(pluginB: PluginB) {
							super()
							void pluginB
						}
					}
				`,
				output: `
					import { PluginB } from './PluginB'

					@Plugin({ name: 'PluginA' })
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
					import type { PluginB, Helper } from './PluginB'

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						constructor(pluginB: PluginB) {
							super()
							void pluginB
						}
					}
				`,
				output: `
					import { PluginB, type Helper } from './PluginB'

					@Plugin({ name: 'PluginA' })
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
					import { type PluginB as Dep, Helper } from './PluginB'

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						constructor(dep: Dep) {
							super()
							void dep
						}
					}
				`,
				output: `
					import { PluginB as Dep, Helper } from './PluginB'

					@Plugin({ name: 'PluginA' })
					class PluginA extends BasePlugin {
						constructor(dep: Dep) {
							super()
							void dep
						}
					}
				`,
				errors: [{ messageId: 'typeOnly' }],
			},
		],
	},
)

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
