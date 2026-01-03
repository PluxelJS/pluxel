import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { createFixture } from 'fs-fixture'
import { rolldown } from 'rolldown'
import { configSourcePlugin } from '../src/plugins/configSourcePlugin'
import { importTypeFixerPlugin } from '../src/plugins/importTypeFixerPlugin'

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
import { BasePlugin, Config as UseConfig, Plugin, type Config as InferConfig } from '@pluxel/hmr'

const aliasSchema = v.object({
	name: v.string(),
})

@Plugin({ name: 'AliasConfigPlugin' })
export class AliasConfigPlugin extends BasePlugin {
	@UseConfig(aliasSchema)
	aliasConfig!: InferConfig<typeof aliasSchema>
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
} satisfies Record<string, string>

async function withFixtures<T>(run: (fixturesDir: string) => Promise<T>) {
	await using fixture = await createFixture(fixtureFiles)
	return await run(fixture.path)
}

describe('configSourcePlugin', () => {
	it('extracts inline @Config schema source', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			// 应该包含 __setConfigSource__ 调用
			expect(code).toContain('__setConfigSource__')

			// 应该包含内联 schema 的源码
			expect(code).toContain('v.object({inline:v.boolean()})')
		})
	})

	it('extracts aliased @Config decorator imports', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config-alias.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/hmr', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__')
			expect(code).toContain('__setConfigSource__(AliasConfigPlugin')
			expect(code).toContain('v.object({name:v.string()})')
		})
	})

	it('extracts local schema source', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			// 应该包含本地 schema 的源码（注意末尾可能有逗号）
			expect(code).toMatch(
				/v\.object\(\{name:v\.string\(\),count:v\.pipe\(v\.number\(\),v\.integer\(\)\),?\}\)/,
			)
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
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config.ts'),
				plugins: [configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			// 应该为每个 @Config 字段生成调用
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
			expect(code).toContain('v.object({apiKey:v.string(),endpoint:v.pipe(v.string(),v.url()),retryCount:v.optional(v.pipe(v.number(),v.integer(),v.minValue(0)),3)})')
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

describe('importTypeFixerPlugin', () => {
	it('emits runtime-safe output for type-only imports', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-type-import.ts'),
				plugins: [importTypeFixerPlugin()],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).not.toContain('import type')
			expect(code).toContain('TypeImportPlugin')
			expect(code).toContain('constructor')
		})
	})

	it('keeps constructor params for type-only imports', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-type-import.ts'),
				plugins: [importTypeFixerPlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).not.toContain('import type')
			expect(code).toContain('constructor(someService, anotherService, regular)')
		})
	})
})

describe('plugins integration', () => {
	it('composes importTypeFixer with configSourcePlugin', async () => {
		await withFixtures(async (fixturesDir) => {
			const bundle = await rolldown({
				input: resolve(fixturesDir, 'plugin-with-config.ts'),
				plugins: [importTypeFixerPlugin(), configSourcePlugin()],
				external: ['valibot', '@pluxel/core'],
			})

			const { output } = await bundle.generate({ format: 'esm' })
			const code = output[0].code

			expect(code).toContain('__setConfigSource__')
			expect(code).toContain('TestPlugin')
		})
	})
})
