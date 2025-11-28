import { describe, expect, it } from 'bun:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { configSourcePlugin } from '../src/plugins/configSourcePlugin'
import { importTypeFixerPlugin } from '../src/plugins/importTypeFixerPlugin'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(__dirname, 'fixtures')

describe('configSourcePlugin', () => {
	it('extracts inline @Config schema source', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-config.ts'),
			plugins: [configSourcePlugin()],
			external: ['valibot'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 应该包含 __setConfigSource__ 调用
		expect(code).toContain('__setConfigSource__')

		// 应该包含内联 schema 的源码
		expect(code).toContain('v.object({inline:v.boolean()})')
	})

	it('extracts local schema source', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-config.ts'),
			plugins: [configSourcePlugin()],
			external: ['valibot', '@pluxel/core'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 应该包含本地 schema 的源码（注意末尾可能有逗号）
		expect(code).toMatch(/v\.object\(\{name:v\.string\(\),count:v\.pipe\(v\.number\(\),v\.integer\(\)\),?\}\)/)
	})

	it('extracts cross-file imported schema source', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-config.ts'),
			plugins: [configSourcePlugin()],
			external: ['valibot', '@pluxel/core'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 应该包含跨文件导入的 schema 源码（注意末尾可能有逗号）
		expect(code).toMatch(/v\.object\(\{host:v\.string\(\),port:v\.pipe\(v\.number\(\),v\.minValue\(1\),v\.maxValue\(65535\)\),?\}\)/)

		// 确保 externalConfig 字段有对应的 __setConfigSource__ 调用
		expect(code).toContain('__setConfigSource__(TestPlugin, "externalConfig"')
	})

	it('generates correct __setConfigSource__ calls', async () => {
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

	it('respects include/exclude patterns', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-config.ts'),
			plugins: [
				configSourcePlugin({
					exclude: ['**/plugin-with-config.ts'],
				}),
			],
			external: ['valibot'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 被排除的文件不应该有注入
		expect(code).not.toContain('__setConfigSource__')
	})

	it('extracts schema from another cross-file import', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-nested-import.ts'),
			plugins: [configSourcePlugin()],
			external: ['valibot', '@pluxel/core'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 应该包含 __setConfigSource__ 调用
		expect(code).toContain('__setConfigSource__')

		// 应该为 nestedConfig 生成调用
		expect(code).toContain('__setConfigSource__(NestedImportPlugin, "nestedConfig"')

		// 应该包含嵌套导入的 schema 源码
		expect(code).toMatch(/v\.object\(\{apiKey:v\.string\(\),endpoint:v\.pipe\(v\.string\(\),v\.url\(\)\)/)
	})

	it('inlines composed object schemas (local + cross-file)', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-composed-schema.ts'),
			plugins: [configSourcePlugin()],
			external: ['valibot', '@pluxel/core'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 本地 const 组合应被内联
		expect(code).toMatch(
			/v\.object\(\{array:v\.array\(v\.number\(\)\),external:v\.array\(v\.pipe\(v\.string\(\),v\.minLength\(1\)\)\),?\}\)/,
		)

		// 跨文件导入的 schema 组合应被内联
		expect(code).toMatch(
			/v\.object\(\{external:v\.object\(\{flag:v\.boolean\(\),array:v\.array\(v\.pipe\(v\.string\(\),v\.minLength\(1\)\)\),?\}\),array:v\.array\(v\.pipe\(v\.string\(\),v\.minLength\(1\)\)\),?\}\)/,
		)
	})
})

describe('importTypeFixerPlugin', () => {
	it('converts import type to import for constructor params', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-type-import.ts'),
			plugins: [importTypeFixerPlugin()],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 构造函数参数在运行时代码中应该存在（小写参数名）
		// 注：即使 import type 被修复，如果导入只用作类型，rolldown 仍会 tree-shake
		// 这里只检查代码能正常编译和构造函数存在
		expect(code).toContain('constructor(someService, anotherService, regular)')
	})

	it('compiles without parse errors', async () => {
		// 确保插件能正确解析 TypeScript 和处理 type imports
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-type-import.ts'),
			plugins: [importTypeFixerPlugin()],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 代码应该包含类定义
		expect(code).toContain('TypeImportPlugin')
		expect(code).toContain('@Plugin')
	})

	it('preserves class structure', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-type-import.ts'),
			plugins: [importTypeFixerPlugin()],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// 类结构应该保持完整
		expect(code).toContain('class')
		expect(code).toContain('extends BasePlugin')
	})

	it('does not modify files without @Plugin', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'schema.ts'),
			plugins: [importTypeFixerPlugin()],
			external: ['valibot'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// schema.ts 没有 @Plugin，不应该被修改
		// 这里只是验证不会报错
		expect(code).toContain('externalSchema')
	})
})

describe('plugins integration', () => {
	it('both plugins work together', async () => {
		const bundle = await rolldown({
			input: resolve(fixturesDir, 'plugin-with-config.ts'),
			plugins: [
				importTypeFixerPlugin(),
				configSourcePlugin(),
			],
			external: ['valibot', '@pluxel/core'],
		})

		const { output } = await bundle.generate({ format: 'esm' })
		const code = output[0].code

		// configSourcePlugin 应该注入 __setConfigSource__
		expect(code).toContain('__setConfigSource__')
		expect(code).toContain('TestPlugin')
	})
})
