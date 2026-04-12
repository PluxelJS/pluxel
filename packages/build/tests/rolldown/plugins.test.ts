import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { rolldown } from 'rolldown'
import { configSourcePlugin } from '../../src/rolldown/plugins/configSourcePlugin'
import { hmrUiBridgePlugin } from '../../src/rolldown/plugins/hmrUiBridgePlugin'
import { lintGuardPlugin } from '../../src/rolldown/plugins/lintGuardPlugin'

const buildLintConfigPath = fileURLToPath(
	new URL('../../../../oxlint.build.config.ts', import.meta.url),
)

const fixtureFiles = {
	'composed-parts.ts': `import * as v from 'valibot'

// 跨文件共享的 schema 片段
export const sharedArray = v.array(v.pipe(v.string(), v.minLength(1)))

export const sharedObject = v.object({
	flag: v.boolean(),
	array: sharedArray,
})

// 用于 spread 拼接的基础字段对象
export const baseFields = {
	name: v.string(),
	id: v.pipe(v.number(), v.integer()),
}

// 用于 shorthand 的单独 schema
export const enabledSchema = v.boolean()
export const countSchema = v.pipe(v.number(), v.minValue(0))

// 深层嵌套的 object
export const deepNested = v.object({
	level1: v.object({
		level2: v.object({
			value: v.string(),
		}),
	}),
})
`,
	'nested-schema.ts': `// 深层嵌套的 schema 定义 - 用于测试跨文件导入
import * as v from 'valibot'

export const nestedSchema = v.object({
	apiKey: v.string(),
	endpoint: v.pipe(v.string(), v.url()),
	retryCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 3),
})
`,
	'plugin-with-composed-schema.ts': `import * as v from 'valibot'
import {
	baseFields,
	countSchema,
	deepNested,
	enabledSchema,
	sharedArray,
	sharedObject,
} from './composed-parts'

const localArray = v.array(v.number())
const localObject = v.object({
	array: localArray,
	external: sharedArray,
})

// 本地 shorthand 用的 schema
const timeout = v.optional(v.number(), 5000)

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'ComposedPlugin' })
export class ComposedPlugin extends BasePlugin {
	// 1. 组合了本地 const
	@Config(localObject)
	private local!: any

	// 2. 组合了跨文件导入的 schema
	@Config(
		v.object({
			external: sharedObject,
			array: sharedArray,
		}),
	)
	private external!: any

	// 3. spread 拼接 - 跨文件的基础字段
	@Config(
		v.object({
			...baseFields,
			extra: v.boolean(),
		}),
	)
	private spread!: any

	// 4. shorthand 属性 - 跨文件 schema
	@Config(
		v.object({
			enabledSchema,
			countSchema,
		}),
	)
	private shorthand!: any

	// 5. 本地 shorthand
	@Config(
		v.object({
			timeout,
			name: v.string(),
		}),
	)
	private localShorthand!: any

	// 6. 深层嵌套 object
	@Config(deepNested)
	private nested!: any

	// 7. v.objectAsync 变体
	@Config(
		v.objectAsync({
			asyncField: v.string(),
			nested: sharedObject,
		}),
	)
	private asyncSchema!: any

	// 8. 混合场景：spread + shorthand + 跨文件
	@Config(
		v.object({
			...baseFields,
			enabledSchema,
			nested: sharedObject,
		}),
	)
	private mixed!: any
}
`,
	'plugin-with-config-alias.ts': `import * as v from 'valibot'
import { BasePlugin, Config as UseConfig, Plugin, type Config as InferConfig } from '@pluxel/core'

const aliasSchema = v.object({
	name: v.string(),
})

@Plugin({ name: 'AliasConfigPlugin' })
export class AliasConfigPlugin extends BasePlugin {
	@UseConfig(aliasSchema)
	aliasConfig!: InferConfig<typeof aliasSchema>
}
`,
	'plugin-with-config-valibot-namespace.ts': `// 测试 valibot namespace alias 的 schema 源码提取
import * as valibot from 'valibot'

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

const localSchema = valibot.object({
	name: valibot.string(),
	count: valibot.pipe(valibot.number(), valibot.integer()),
})

@Plugin({ name: 'ValibotNamespacePlugin' })
export class ValibotNamespacePlugin extends BasePlugin {
	@Config(localSchema)
	private localConfig!: any
}
`,
	'plugin-with-config-valibot-form-namespace.ts': `// 测试 valibot-form namespace alias 的 schema 源码提取
	import * as v from 'valibot'
	import * as valibotForm from 'valibot-form'

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

const schema = v.object({
	// meta 函数来自 valibot-form（runtime 只会提供 f，因此必须被重写）
	name: v.pipe(v.string(), valibotForm.stringMeta({ label: 'Name' })),
})

@Plugin({ name: 'ValibotFormNamespacePlugin' })
	export class ValibotFormNamespacePlugin extends BasePlugin {
		@Config(schema)
		private config!: any
	}
	`,
	'plugin-with-config-valibot-named-import.ts': `// 测试 valibot named imports 的 schema 源码提取
	import { object, string, number, integer, pipe } from 'valibot'

	function Plugin(_meta?: any): ClassDecorator {
		return () => {}
	}

	function Config(_schema: any): PropertyDecorator {
		return () => {}
	}

	class BasePlugin {}

	const localSchema = object({
		name: string(),
		count: pipe(number(), integer()),
	})

	@Plugin({ name: 'ValibotNamedImportPlugin' })
	export class ValibotNamedImportPlugin extends BasePlugin {
		@Config(localSchema)
		private config!: any
	}
	`,
	'plugin-with-config-valibot-form-named-import.ts': `// 测试 valibot-form named imports 的 schema 源码提取
	import * as v from 'valibot'
	import { stringMeta } from 'valibot-form'

	function Plugin(_meta?: any): ClassDecorator {
		return () => {}
	}

	function Config(_schema: any): PropertyDecorator {
		return () => {}
	}

	class BasePlugin {}

	const schema = v.object({
		name: v.pipe(v.string(), stringMeta({ label: 'Name' })),
	})

	@Plugin({ name: 'ValibotFormNamedImportPlugin' })
	export class ValibotFormNamedImportPlugin extends BasePlugin {
		@Config(schema)
		private config!: any
	}
	`,
	'plugin-with-config.ts': `// 测试 @Config 源码提取的插件文件
	import * as v from 'valibot'
	import { externalSchema } from './schema'

// 本地定义的 schema
const localSchema = v.object({
	name: v.string(),
	count: v.pipe(v.number(), v.integer()),
})

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'TestPlugin' })
export class TestPlugin extends BasePlugin {
	// 使用本地 schema
	@Config(localSchema)
	private localConfig!: any

	// 使用内联 schema
	@Config(v.object({ inline: v.boolean() }))
	private inlineConfig!: any

	// 使用跨文件导入的 schema
	@Config(externalSchema)
	private externalConfig!: any
}
`,
	'plugin-with-computed-config.ts': `// 测试 computed key 的 schema
import * as v from 'valibot'

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

const key = 'dynamic'

@Plugin({ name: 'ComputedKeyPlugin' })
export class ComputedKeyPlugin extends BasePlugin {
	@Config(v.object({ [key]: v.string(), ['static']: v.number() }))
	private config!: any
}
`,
	'plugin-with-nested-import.ts': `// 测试直接跨文件导入 schema 的插件（不通过中间模块）
import * as v from 'valibot'
import { nestedSchema } from './nested-schema'

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'NestedImportPlugin' })
export class NestedImportPlugin extends BasePlugin {
	// 通过中间模块导入的 schema
	@Config(nestedSchema)
	private nestedConfig!: any

	// 内联 schema 作为对照
	@Config(v.object({ inline: v.boolean() }))
	private inlineConfig!: any
}
`,
	'plugin-with-type-import.ts': `// 测试 import type 修复的插件文件
import type { SomeService } from './services';
import type { AnotherService, RegularImport } from './services';

// 模拟装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'TypeImportPlugin' })
export class TypeImportPlugin extends BasePlugin {
	constructor(
		private someService: SomeService,
		private anotherService: AnotherService,
		private regular: RegularImport,
	) {
		super()
	}
}
`,
	'plugin-with-type-import-alias.ts': `// 测试 import type + alias 修复
import { type SomeService as ServiceAlias } from './services'

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'TypeImportAliasPlugin' })
export class TypeImportAliasPlugin extends BasePlugin {
	constructor(private service: ServiceAlias) {
		super()
	}
}
`,
	'schema.js': `// 跨文件 schema 定义 (JavaScript)
import * as v from 'valibot'

export const externalSchema = v.object({
	host: v.string(),
	port: v.pipe(v.number(), v.minValue(1), v.maxValue(65535)),
})

export const anotherSchema = v.object({
	enabled: v.boolean(),
	timeout: v.optional(v.number(), 5000),
})
`,
	'schema.ts': `// 跨文件 schema 定义
import * as v from 'valibot'

export const externalSchema = v.object({
	host: v.string(),
	port: v.pipe(v.number(), v.minValue(1), v.maxValue(65535)),
})

export const anotherSchema = v.object({
	enabled: v.boolean(),
	timeout: v.optional(v.number(), 5000),
})
`,
	'services.ts': `// 模拟服务类
export class SomeService {
	doSomething() {
		return 'something'
	}
}

export class AnotherService {
	doAnother() {
		return 'another'
	}
}

export class RegularImport {
	regular() {
		return 'regular'
	}
}
`,
	'plugin-with-feature-use.ts': `// Test extraction of features.use(...) class-field initializer
import { BasePlugin, Plugin } from '@pluxel/core'

function PluginDecorator(_meta?: any): ClassDecorator {
	return () => {}
}

@PluginDecorator({ name: 'FeatureHostPlugin' })
export class FeatureHostPlugin extends BasePlugin {
	feature = this.features.use(CacheFeature)
}

export class CacheFeature {}
`,
	'plugin-build-lint-valid.ts': `import { SomeService } from './services'

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	configs = { use(value: unknown) { return value } }
	features = { use<T>(value: T) { return value } }
}

const schema = { ok: true }

class CacheFeature {}

@Plugin({ name: 'BuildLintValidPlugin' })
export class BuildLintValidPlugin extends BasePlugin {
	config = this.configs.use(schema)
	cache = this.features.use(CacheFeature)

	constructor(private readonly service: SomeService) {
		super()
		void service
	}
}
`,
	'plugin-build-lint-invalid-type-import.ts': `import type { SomeService } from './services'

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'BuildLintInvalidTypeImportPlugin' })
export class BuildLintInvalidTypeImportPlugin extends BasePlugin {
	constructor(private readonly service: SomeService) {
		super()
		void service
	}
}
`,
	'plugin-build-lint-invalid-private-config.ts': `function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	configs = { use(value: unknown) { return value } }
}

const schema = { ok: true }

@Plugin({ name: 'BuildLintInvalidPrivateConfigPlugin' })
export class BuildLintInvalidPrivateConfigPlugin extends BasePlugin {
	#config = this.configs.use(schema)
}
`,
	'plugin-build-lint-invalid-feature-nested.ts': `function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	features = { use<T>(value: T) { return value } }
}

class CacheFeature {}

export function makePlugin() {
	@Plugin({ name: 'BuildLintInvalidFeatureNestedPlugin' })
	class BuildLintInvalidFeatureNestedPlugin extends BasePlugin {
		cache = this.features.use(CacheFeature)
	}
	return BuildLintInvalidFeatureNestedPlugin
}
`,
	'plugin-build-lint-invalid-config-nested.ts': `function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	configs = { use(value: unknown) { return value } }
}

const schema = { ok: true }

export function makePlugin() {
	@Plugin({ name: 'BuildLintInvalidConfigNestedPlugin' })
	class BuildLintInvalidConfigNestedPlugin extends BasePlugin {
		config = this.configs.use(schema)
	}
	return BuildLintInvalidConfigNestedPlugin
}
`,
	'plugin-build-lint-invalid-config-early-read.ts': `function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	configs = { use(value: unknown) { return value } }
}

const schema = { ok: true }

@Plugin({ name: 'BuildLintInvalidConfigEarlyReadPlugin' })
export class BuildLintInvalidConfigEarlyReadPlugin extends BasePlugin {
	config = this.configs.use(schema)
	ready = this.config
}
`,
	'plugin-build-lint-invalid-config-redefault.ts': `function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	configs = { use(value: unknown) { return value } }
}

const schema = { ok: true }

@Plugin({ name: 'BuildLintInvalidConfigRedefaultPlugin' })
export class BuildLintInvalidConfigRedefaultPlugin extends BasePlugin {
	config = this.configs.use(schema)

	init() {
		return this.config ?? {}
	}
}
`,
	'plugin-with-hmr-ui.ts': `import { ui } from '@pluxel/hmr/plugin'

class BasePlugin {
	ctx: any
}

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

const pluginUi = ui('./ui/index.tsx')

@Plugin({ name: 'UiBridgePlugin' })
export class UiBridgePlugin extends BasePlugin {
	init() {
		return pluginUi.bind(this.ctx)
	}
}
`,
	'plugin-with-hmr-ui-alias.ts': `import { ui as defineUi, worker } from '@pluxel/hmr/plugin'

class BasePlugin {
	ctx: any
}

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

export const demoWorker = worker('./worker.ts')
const pluginUi = defineUi({ entryPath: './ui/index.tsx' })

@Plugin({ name: 'UiAliasBridgePlugin' })
export class UiAliasBridgePlugin extends BasePlugin {
	init() {
		return pluginUi.bind(this.ctx)
	}
}
`,
	'plugin-with-hmr-ui-namespace.ts': `import * as hmrPlugin from '@pluxel/hmr/plugin'

class BasePlugin {
	ctx: any
}

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

const pluginUi = hmrPlugin.ui('./ui/index.tsx')

@Plugin({ name: 'UiNamespaceBridgePlugin' })
export class UiNamespaceBridgePlugin extends BasePlugin {
	init() {
		return pluginUi.bind(this.ctx)
	}
}
`,
	'plugin-with-cfg-layout.ts': `import * as v from 'valibot'
	import { cfg } from '@pluxel/core'

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	// only for syntax; not executed in this test bundle
	configs: any = { use: (_x: any) => ({}) }
}

@Plugin({ name: 'CfgLayoutPlugin' })
export class CfgLayoutPlugin extends BasePlugin {
	static readonly schemas = {
		a: v.object({ a: v.boolean() }),
		b: v.object({ b: v.boolean() }),
	} as const

		private static readonly c = cfg(CfgLayoutPlugin.schemas)

		settings = this.configs.use(
			CfgLayoutPlugin.c\`
				# Layout
				\${CfgLayoutPlugin.c.schema('a')}
				\${CfgLayoutPlugin.c.schema('b')}
				\${CfgLayoutPlugin.c.schemas()}
			\`,
		)
	}
	`,
	'cfg-schemas-imported.ts': `import * as v from 'valibot'
import { cfg } from '@pluxel/core'
import { schemas as importedSchemas } from './cfg-schemas-map'

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	// only for syntax; not executed in this test bundle
	configs: any = { use: (_x: any) => ({}) }
}

@Plugin({ name: 'CfgImportedSchemasPlugin' })
export class CfgImportedSchemasPlugin extends BasePlugin {
	private static readonly c = cfg(importedSchemas)

	settings = this.configs.use(
		CfgImportedSchemasPlugin.c\`
			# Layout
			\${CfgImportedSchemasPlugin.c.schema('a')}
			\${CfgImportedSchemasPlugin.c.schemas()}
		\`,
	)
}
`,
	'cfg-schemas-map.ts': `import * as v from 'valibot'

export const schemas = {
	a: v.object({ a: v.boolean() }),
	b: v.object({ b: v.boolean() }),
} as const
`,
	'invalid-cfg-layout.ts': `import * as v from 'valibot'
import { cfg } from '@pluxel/core'

function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {
	configs: any = { use: (_x: any) => ({}) }
}

@Plugin({ name: 'InvalidCfgLayoutPlugin' })
export class InvalidCfgLayoutPlugin extends BasePlugin {
	private static readonly schemas = {
		a: v.object({ a: v.boolean() }),
		b: v.object({ b: v.boolean() }),
	} as const

	private static readonly c = cfg(InvalidCfgLayoutPlugin.schemas)

	settings = this.configs.use(
		InvalidCfgLayoutPlugin.c\`
			\${InvalidCfgLayoutPlugin.c.schemas()}
			\${InvalidCfgLayoutPlugin.c.schema('a')}
		\`,
	)
}
`,
} satisfies Record<string, string>

async function withFixtures<T>(run: (fixturesDir: string) => Promise<T>) {
	await using fixture = await createFixture(fixtureFiles)
	return await run(fixture.path)
}

async function generateCode(options: {
	fixturesDir: string
	input: string
	plugins: NonNullable<Parameters<typeof rolldown>[0]>['plugins']
	external?: string[]
}) {
	const bundle = await rolldown({
		input: resolve(options.fixturesDir, options.input),
		plugins: options.plugins,
		...(options.external ? { external: options.external } : {}),
	})

	const { output } = await bundle.generate({ format: 'esm' })
	return output[0].code
}

async function generateWithLintGuard(
	fixturesDir: string,
	input: string,
	options: Partial<Parameters<typeof lintGuardPlugin>[0]> = {},
) {
	const bundle = await rolldown({
		input: resolve(fixturesDir, input),
		plugins: [
			lintGuardPlugin({
				cwd: fixturesDir,
				configPath: buildLintConfigPath,
				paths: [input],
				mode: 'enforce',
				...options,
			}),
		],
	})

	return await bundle.generate({ format: 'esm' })
}

const buildLintFailureCases = [
	[
		'type-only constructor dependency imports',
		'plugin-build-lint-invalid-type-import.ts',
		'plugin-constructor-no-type-only-imports',
	],
	[
		'configs.use(...) private fields',
		'plugin-build-lint-invalid-private-config.ts',
		'configs-use-no-private-field',
	],
	[
		'nested features.use(...) declarations',
		'plugin-build-lint-invalid-feature-nested.ts',
		'features-use-top-level-class',
	],
	[
		'nested configs.use(...) declarations',
		'plugin-build-lint-invalid-config-nested.ts',
		'configs-use-top-level-class',
	],
	[
		'early reads of configs.use(...) fields',
		'plugin-build-lint-invalid-config-early-read.ts',
		'configs-use-no-early-read',
	],
	[
		're-defaulting configs.use(...) outputs',
		'plugin-build-lint-invalid-config-redefault.ts',
		'configs-use-no-redefault',
	],
] as const

describe('configSourcePlugin', () => {
	it('extracts cfg(schemaMap)`...` layout parts', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-cfg-layout.ts',
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			expect(code).toContain('__setConfigLayout__')
			expect(code).toContain('"kind": "schema"')
			expect(code).toContain('"key": "a"')
			expect(code).toContain('"key": "b"')
			expect(code).toContain('"kind": "schemas"')
		})
	})

	it('extracts cfg(schemaMap) across modules (imported schemaMap const)', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'cfg-schemas-imported.ts',
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			expect(code).toContain('__registerConfigBinding__')
			expect(code).toContain('__setConfigSource__')
			expect(code).toContain('__setConfigLayout__')
			expect(code).toContain('["a"]')
			expect(code).toContain('["b"]')
		})
	})

	it('rejects invalid cfg layout ordering during extraction', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'invalid-cfg-layout.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			await expect(bundle.generate({ format: 'esm' })).rejects.toThrow(
				/must be the last schema-placement token/,
			)
		})
	})

	it('extracts inline @Config schema source', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-config.ts',
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			expect(code).toContain('__setConfigSource__')
			expect(code).toContain('v.object({inline:v.boolean()})')
		})
	})

	it('extracts aliased @Config decorator imports', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-config-alias.ts',
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/runtime', '@pluxel/core'],
			})

			expect(code).toContain('__setConfigSource__')
			expect(code).toContain('__setConfigSource__(AliasConfigPlugin')
			expect(code).toContain('v.object({name:v.string()})')
		})
	})

	it('injects __registerUsedFeatures__ for features.use(...) class fields', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-feature-use.ts',
				plugins: [configSourcePlugin()],
				external: ['@pluxel/core'],
			})

			expect(code).toContain('__registerUsedFeatures__')
			expect(code).toContain('__registerUsedFeatures__(FeatureHostPlugin, CacheFeature)')
		})
	})

	it('rewrites valibot namespace imports to runtime "v"', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config-valibot-namespace.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__')
			expect(code).toContain(
				'__setConfigSource__(ValibotNamespacePlugin, "localConfig", "v.object({name:v.string(),count:v.pipe(v.number(),v.integer())})")',
			)
		})
	})

	it('rewrites valibot-form namespace imports to runtime "f"', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config-valibot-form-namespace.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', 'valibot-form', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__')
			const match =
				/__setConfigSource__\(\s*ValibotFormNamespacePlugin\s*,\s*"config"\s*,\s*"([^"]*)"\s*\)/.exec(
					code,
				)
			expect(match).toBeTruthy()
			const injected = match?.[1] ?? ''
			expect(injected).toContain('f.stringMeta')
			expect(injected).not.toContain('valibotForm.stringMeta')
		})
	})

	it('rewrites valibot named imports to runtime "v"', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config-valibot-named-import.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__')
			expect(code).toContain(
				'__setConfigSource__(ValibotNamedImportPlugin, "config", "v.object({name:v.string(),count:v.pipe(v.number(),v.integer())})")',
			)
		})
	})

	it('rewrites valibot-form named imports to runtime "f"', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config-valibot-form-named-import.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', 'valibot-form', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__')
			const match =
				/__setConfigSource__\(\s*ValibotFormNamedImportPlugin\s*,\s*"config"\s*,\s*"([^"]*)"\s*\)/.exec(
					code,
				)
			expect(match).toBeTruthy()
			const injected = match?.[1] ?? ''
			expect(injected).toContain('f.stringMeta')
			expect(injected).not.toMatch(/(^|[^.])stringMeta\(/)
		})
	})

	it('handles computed keys inside schema objects', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-computed-config.ts',
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			expect(code).toContain('__setConfigSource__(ComputedKeyPlugin')
			expect(code).toContain('[key]:v.string()')
			expect(code).toContain("['static']:v.number()")
		})
	})

	it('extracts cross-file imported schema source', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			// 应该包含跨文件导入的 schema 源码（注意末尾可能有逗号）
			expect(code).toMatch(
				/v\.object\(\{host:v\.string\(\),port:v\.pipe\(v\.number\(\),v\.minValue\(1\),v\.maxValue\(65535\)\),?\}\)/,
			)

			// 确保 externalConfig 字段有对应的 __setConfigSource__ 调用
			expect(code).toContain('__setConfigSource__(TestPlugin, "externalConfig"')
		})
	})

	it('generates correct __setConfigSource__ calls', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-config.ts',
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			expect(code).toContain('__setConfigSource__(TestPlugin')
			expect(code).toContain('"localConfig"')
			expect(code).toContain('"inlineConfig"')
			expect(code).toContain('"externalConfig"')
		})
	})

	it('respects include/exclude patterns', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config.ts'),
				plugins: [
					configSourcePlugin({
						exclude: ['**/plugin-with-config.ts'],
					}),
				],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			// 被排除的文件不应该有注入
			expect(code).not.toContain('__setConfigSource__')
		})
	})

	it('extracts schema from another cross-file import', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-nested-import.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__(NestedImportPlugin')
			expect(code).toContain(
				'v.object({apiKey:v.string(),endpoint:v.pipe(v.string(),v.url()),retryCount:v.optional(v.pipe(v.number(),v.integer(),v.minValue(0)),3)})',
			)
		})
	})

	it('extracts composed schema pieces', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-composed-schema.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__(ComposedPlugin')
			// 本地 + 跨文件组合
			expect(code).toMatch(
				/v\.object\(\{array:v\.array\(v\.number\(\)\),external:v\.array\(v\.pipe\(v\.string\(\),v\.minLength\(1\)\)\),?\}\)/,
			)
			expect(code).toMatch(
				/v\.object\(\{external:v\.object\(\{flag:v\.boolean\(\),array:v\.array\(v\.pipe\(v\.string\(\),v\.minLength\(1\)\)\),?\}\),array:v\.array\(v\.pipe\(v\.string\(\),v\.minLength\(1\)\)\),?\}\)/,
			)
			// spread + shorthand + 本地 shorthand
			expect(code).toMatch(
				/\.\.\.\{name:v\.string\(\),id:v\.pipe\(v\.number\(\),v\.integer\(\)\),?\}/,
			)
			expect(code).toMatch(/enabledSchema:v\.boolean\(\)/)
			expect(code).toMatch(/countSchema:v\.pipe\(v\.number\(\),v\.minValue\(0\)\)/)
			expect(code).toMatch(/timeout:v\.optional\(v\.number\(\),5000\)/)
			// 深层嵌套与 async schema
			expect(code).toMatch(
				/v\.object\(\{level1:v\.object\(\{level2:v\.object\(\{value:v\.string\(\),?\}\),?\}\),?\}\)/,
			)
			expect(code).toMatch(/v\.objectAsync\(\{asyncField:v\.string\(\)/)
			expect(code).toMatch(/nested:v\.object\(\{flag:v\.boolean\(\)/)
			// mixed 场景保持
			expect(code).toContain('mixed')
		})
	})
})

describe('plugins integration', () => {
	it('allows valid plugin authoring through build lint guard', async () => {
		await withFixtures(async (fixturesDir) => {
			await expect(
				generateWithLintGuard(fixturesDir, 'plugin-build-lint-valid.ts'),
			).resolves.toBeDefined()
		})
	})

	it('reruns lint on subsequent builds in the same process', async () => {
		await withFixtures(async (fixturesDir) => {
			const input = 'plugin-build-lint-valid.ts'
			await expect(generateWithLintGuard(fixturesDir, input)).resolves.toBeDefined()

			writeFileSync(
				resolve(fixturesDir, input),
				fixtureFiles['plugin-build-lint-invalid-type-import.ts'],
				'utf8',
			)

			await expect(generateWithLintGuard(fixturesDir, input)).rejects.toThrow(
				/plugin-constructor-no-type-only-imports/,
			)
		})
	})

	it('resolves a relative lint config path from plugin cwd', async () => {
		await withFixtures(async (fixturesDir) => {
			await expect(
				generateWithLintGuard(fixturesDir, 'plugin-build-lint-valid.ts', {
					configPath: relative(fixturesDir, buildLintConfigPath),
				}),
			).resolves.toBeDefined()
		})
	})

	for (const [label, input, ruleName] of buildLintFailureCases) {
		it(`fails build on ${label}`, async () => {
			await withFixtures(async (fixturesDir) => {
				await expect(generateWithLintGuard(fixturesDir, input)).rejects.toThrow(
					new RegExp(ruleName),
				)
			})
		})
	}

	it('rewrites HMR ui bridge imports into runtime packaged helpers', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-hmr-ui.ts',
				plugins: [hmrUiBridgePlugin()],
				external: ['@pluxel/hmr/plugin'],
			})

			expect(code).toContain('ctx.ext.ui.remote.packaged()')
			expect(code).toContain('__pluxelRuntimeUiBridge__')
			expect(code).not.toContain("import { ui } from '@pluxel/hmr/plugin'")
		})
	})

	it('preserves non-ui hmr imports while rewriting aliased ui bindings', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-hmr-ui-alias.ts',
				plugins: [hmrUiBridgePlugin()],
				external: ['@pluxel/hmr/plugin'],
			})

			expect(code).toContain('import { worker } from "@pluxel/hmr/plugin";')
			expect(code).toContain('const defineUi = __pluxelRuntimeUiBridge__')
			expect(code).toContain('ctx.ext.ui.remote.packaged()')
			expect(code).not.toContain('ui as defineUi')
		})
	})

	it('rejects namespace imports from @pluxel/hmr/plugin to keep AST rewrite deterministic', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-hmr-ui-namespace.ts'),
				plugins: [hmrUiBridgePlugin()],
				external: ['@pluxel/hmr/plugin'],
			})

			await expect(bundle.generate({ format: 'esm' })).rejects.toThrow(
				/namespace import is not supported/,
			)
		})
	})

	it('composes configSourcePlugin on plugin modules', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-config.ts',
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			expect(code).toContain('__setConfigSource__')
			expect(code).toContain('TestPlugin')
		})
	})

	it('composes hmrUiBridgePlugin with existing build plugins', async () => {
		await withFixtures(async (fixturesDir) => {
			const code = await generateCode({
				fixturesDir,
				input: 'plugin-with-hmr-ui.ts',
				plugins: [configSourcePlugin(), hmrUiBridgePlugin()],
				external: ['@pluxel/hmr/plugin'],
			})

			expect(code).toContain('ctx.ext.ui.remote.packaged()')
			expect(code).toContain('UiBridgePlugin')
		})
	})
})
