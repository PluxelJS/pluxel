import { expect, it, vi } from 'vitest'
import { Server } from 'node:net'
import { fileURLToPath } from 'node:url'
import { workspaceSeed } from '../src/backend/seeds.js'
import { TemplateCompiler } from '../src/backend/compiler.js'
import type { WorkspaceSnapshot } from '../src/shared/contracts.js'

const source = `import * as v from 'valibot';
import { defineTypstDocument } from '@pluxel/typst/template';
import { value } from './value.ts';
const schema = v.object({});
const template = './main.typ';
export const helper = 'unrelated named utility export';
export default defineTypstDocument({ template, schema, createFiles() { return { '/inputs/data.json': { kind: 'json', value } }; } })
`
function template(id = 'one'): WorkspaceSnapshot {
	return {
		project: { id, name: id, root: '/workspace' },
		revision: '1',
		assets: [],
		config: {
			name: id,
			fonts: [],
		},
		files: {
			'report/report.ts': source,
			'report/value.ts': 'export const value = 1',
			'report/main.typ': 'Test',
		},
	}
}
function evaluate(compiler: TemplateCompiler, doc: WorkspaceSnapshot) {
	return compiler.evaluate(doc, 'report/report.ts', {})
}
it('runs a Vite module runner inside QuickJS without a listener and closes it', async () => {
	const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(() => {
		throw new Error('Unexpected listener')
	})
	const compiler = new TemplateCompiler()
	try {
		const result = await evaluate(compiler, template())
		expect(result.files['/inputs/data.json']).toEqual({ kind: 'json', value: 1 })
		expect(listen).not.toHaveBeenCalled()
	} finally {
		await compiler.close()
		listen.mockRestore()
	}
})
it('applies indirect module HMR updates and template raw updates without replacing the runtime', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	try {
		await evaluate(compiler, doc)
		const next = {
			...doc,
			revision: '2',
			files: { ...doc.files, 'report/value.ts': 'export const value = 2' },
		}
		const updated = await evaluate(compiler, next)
		expect(updated.files['/inputs/data.json']).toEqual({ kind: 'json', value: 2 })
		const layout = await evaluate(compiler, {
			...next,
			revision: '3',
			files: { ...next.files, 'report/main.typ': 'Changed' },
		})
		expect(layout.files['/inputs/data.json']).toEqual({ kind: 'json', value: 2 })
	} finally {
		await compiler.close()
	}
})
it('keeps module state separate between two active templates', async () => {
	const compiler = new TemplateCompiler()
	const other = new TemplateCompiler()
	const first = template('one')
	const second = template('two')
	try {
		await evaluate(compiler, first)
		await evaluate(other, second)
		const next = {
			...first,
			files: { ...first.files, 'report/value.ts': 'export const value = 3' },
		}
		const updated = await evaluate(compiler, next)
		expect(updated.files['/inputs/data.json']).toEqual({ kind: 'json', value: 3 })
		const untouched = await evaluate(other, second)
		expect(untouched.files['/inputs/data.json']).toEqual({ kind: 'json', value: 1 })
	} finally {
		await compiler.close()
		await other.close()
	}
})

it('preserves official hot.data/dispose through indirect dependency and shared Typst updates', async () => {
	let compiler = new TemplateCompiler()
	const doc = template()
	doc.files['report/shared/theme.typ'] = 'Theme one'
	doc.files['report/report.ts'] = `import * as v from 'valibot';
import { defineTypstDocument } from '@pluxel/typst/template';
import { value } from './value.ts';
import theme from './shared/theme.typ?raw';
const updates = import.meta.hot.data.updates ?? 0;
import.meta.hot.dispose(data => { data.updates = updates + 1; });
const schema = v.object({});
const template = './main.typ';
export default defineTypstDocument({ template, schema, createFiles() { return { '/inputs/data.json': { kind: 'json', value: { value, theme, updates } } }; } })`
	try {
		const initial = await evaluate(compiler, doc)
		expect(initial.files['/inputs/data.json']).toEqual({
			kind: 'json',
			value: { value: 1, theme: 'Theme one', updates: 0 },
		})
		const next = { ...doc, files: { ...doc.files, 'report/value.ts': 'export const value = 2' } }
		const changed = await evaluate(compiler, next)
		expect(changed.files['/inputs/data.json']).toEqual({
			kind: 'json',
			value: { value: 2, theme: 'Theme one', updates: 1 },
		})
		const theme = await evaluate(compiler, {
			...next,
			files: { ...next.files, 'report/shared/theme.typ': 'Theme two' },
		})
		expect(theme.files['/inputs/data.json']).toEqual({
			kind: 'json',
			value: { value: 2, theme: 'Theme two', updates: 2 },
		})
		await compiler.close()
		compiler = new TemplateCompiler()
		const reopened = await evaluate(compiler, next)
		expect(reopened.files['/inputs/data.json']).toEqual({
			kind: 'json',
			value: { value: 2, theme: 'Theme one', updates: 0 },
		})
	} finally {
		await compiler.close()
	}
})

it('rejects forged transport imports and recovers the same template after interruption', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	try {
		const forged = {
			...doc,
			files: {
				...doc.files,
				'report/report.ts': `await __studioInvoke(JSON.stringify({type: 'custom', event: 'vite:invoke', data: { name: 'fetchModule', data: ['/etc/passwd'] }}));\n${source}`,
			},
		}
		await expect(evaluate(compiler, forged)).rejects.toThrow('own source tree')
		const looping = {
			...doc,
			files: { ...doc.files, 'report/value.ts': 'while (true) {}\nexport const value = 2' },
		}
		await expect(evaluate(compiler, looping)).rejects.toThrow('模板执行失败')
		const recovered = await evaluate(compiler, doc)
		expect(recovered.files['/inputs/data.json']).toEqual({ kind: 'json', value: 1 })
	} finally {
		await compiler.close()
	}
	await expect(evaluate(compiler, doc)).rejects.toThrow('closed')
})

it('times out a pending top-level await and can compile a corrected template', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	try {
		await expect(
			evaluate(compiler, {
				...doc,
				files: {
					...doc.files,
					'report/value.ts': 'await new Promise(() => {}); export const value = 1',
				},
			}),
		).rejects.toThrow('timed out')
		const recovered = await evaluate(compiler, doc)
		expect(recovered.files['/inputs/data.json']).toEqual({ kind: 'json', value: 1 })
	} finally {
		await compiler.close()
	}
}, 20_000)

it('describes required fields independently of invalid input and preserves structured schema issues', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	try {
		await evaluate(compiler, doc)
		const next = {
			...doc,
			files: {
				...doc.files,
				'report/report.ts': source.replace('v.object({})', 'v.object({ required: v.string() })'),
			},
		}
		await expect(evaluate(compiler, next)).rejects.toMatchObject({
			code: 'INVALID_INPUT',
			issues: expect.arrayContaining([
				expect.objectContaining({ path: ['required'], rule: 'object' }),
			]),
		})
		await expect(
			compiler.evaluate(next, 'report/report.ts', { required: 0 }),
		).rejects.toMatchObject({
			code: 'INVALID_INPUT',
			issues: expect.arrayContaining([
				expect.objectContaining({ path: ['required'], rule: 'string' }),
			]),
		})
		const described = await compiler.describe(next, 'report/report.ts')
		expect(described.defaults).toEqual({})
		expect(described.fields).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'required' })]),
		)
		const recovered = await compiler.evaluate(next, 'report/report.ts', { required: 'provided' })
		expect(recovered.data).toEqual({ required: 'provided' })
		expect(recovered).not.toHaveProperty('fields')
	} finally {
		await compiler.close()
	}
})

it('merges recursive defaults and isolates report input within one workspace', async () => {
	const compiler = new TemplateCompiler()
	const other = new TemplateCompiler()
	const doc = template()
	doc.files['shared/schema.ts'] = `import * as v from 'valibot';
export const schema = v.object({ nested: v.object({ title: v.optional(v.string(), 'Default'), amount: v.optional(v.number(), 1) }) });`
	doc.files['report/report.ts'] =
		`import { schema } from '../shared/schema.ts'; import { defineTypstDocument } from '@pluxel/typst/template'; export default defineTypstDocument({ schema, template: './main.typ' })`
	doc.files['second/second.ts'] =
		`import { schema } from '../shared/schema.ts'; import { defineTypstDocument } from '@pluxel/typst/template'; export default defineTypstDocument({ schema, template: '../report/main.typ' })`
	try {
		const first = await compiler.evaluate(doc, 'report/report.ts', { nested: { title: 'User' } })
		expect(first.data).toEqual({ nested: { title: 'User', amount: 1 } })
		expect(first.template).toBe('report/main.typ')
		expect(first.name).toBe('report')
		const second = await other.evaluate(doc, 'second/second.ts', {})
		expect(second.data).toEqual({ nested: { title: 'Default', amount: 1 } })
		expect(second.name).toBe('second')
		expect(second.files['/inputs/data.json']).toEqual({ kind: 'json', value: second.data })
	} finally {
		await compiler.close()
		await other.close()
	}
})
it('rejects ordinary files, missing exports and escaped template paths, then recovers', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	try {
		await expect(compiler.evaluate(doc, 'report/main.typ', {})).rejects.toThrow('folder/folder.ts')
		for (const code of [
			"export const template = './main.typ'",
			"import * as v from 'valibot'; export const schema = v.object({}); export const template = './main.typ'",
			"import * as v from 'valibot'; export default { schema: v.object({}), template: '../../outside.typ' }",
			"import * as v from 'valibot'; export default { schema: v.object({}), template: './main.typ', name: 'Ignored' }",
			"import * as v from 'valibot'; export default { schema: v.object({}), template: './main.typ', createFiles: true }",
			"import * as v from 'valibot'; export default { schema: v.objectAsync({}), template: './main.typ' }",
		]) {
			await expect(
				compiler.evaluate(
					{ ...doc, files: { ...doc.files, 'report/report.ts': code } },
					'report/report.ts',
					{},
				),
			).rejects.toThrow(/报表|createFiles|Invalid workspace path/)
		}
		const result = await compiler.evaluate(doc, 'report/report.ts', {})
		expect(result.template).toBe('report/main.typ')
		const changed = await compiler.evaluate(
			{
				...doc,
				files: {
					...doc.files,
					'report/second.typ': 'Second',
					'report/report.ts': source.replace('./main.typ', './second.typ'),
				},
			},
			'report/report.ts',
			{},
		)
		expect(changed.template).toBe('report/second.typ')
	} finally {
		await compiler.close()
	}
})

it('evaluates the starter defaults and native Valibot labels without form-specific definitions', async () => {
	const files = await workspaceSeed(
		fileURLToPath(new URL('../financial-document-assets', import.meta.url)),
		'Starter',
	)
	const doc = template('starter')
	doc.files = Object.fromEntries(
		Object.entries(files)
			.filter(([path]) => /\.(ts|typ)$/.test(path))
			.map(([path, value]) => [path, new TextDecoder().decode(value)]),
	)
	const compiler = new TemplateCompiler()
	const other = new TemplateCompiler()
	try {
		const letter = await compiler.evaluate(doc, '报表/银行询证函/银行询证函.ts', {})
		expect(letter.files['/inputs/data.json']).toMatchObject({
			kind: 'json',
			value: { header: { companyName: '示例有限公司' }, accounts: [{ name: '银行存款' }] },
		})
		const letterDescription = await compiler.describe(doc, '报表/银行询证函/银行询证函.ts')
		expect(letterDescription.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'body', meta: expect.objectContaining({ label: '正文' }) }),
			]),
		)
		const summary = await other.evaluate(doc, '报表/银行账户余额汇总表/银行账户余额汇总表.ts', {
			header: { companyName: '外部业务数据' },
		})
		expect(summary.files['/inputs/data.json']).toMatchObject({
			kind: 'json',
			value: { header: { companyName: '外部业务数据', currency: '人民币' } },
		})
		const summaryDescription = await other.describe(
			doc,
			'报表/银行账户余额汇总表/银行账户余额汇总表.ts',
		)
		expect(summaryDescription.fields.some((field) => field.name === 'body')).toBe(false)
	} finally {
		await compiler.close()
		await other.close()
	}
})

it('describes defaults and fields without evaluating createFiles', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	doc.files['report/report.ts'] = `import * as v from 'valibot';
export default { template: './main.typ', schema: v.object({ required: v.string(), count: v.optional(v.number(), 4) }), createFiles() { throw new Error('createFiles was invoked'); } }`
	try {
		const description = await compiler.describe(doc, 'report/report.ts')
		expect(description.defaults).toEqual({ count: 4 })
		expect(description.fields.map((field) => field.name)).toEqual(['required', 'count'])
		await expect(compiler.evaluate(doc, 'report/report.ts', { required: 'valid' })).rejects.toThrow(
			'createFiles was invoked',
		)
	} finally {
		await compiler.close()
	}
})

it('preserves provided array lengths, same-index defaults, empty arrays and explicit falsy values', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	doc.files['report/report.ts'] = `import * as v from 'valibot';
export default { template: './main.typ', schema: v.object({
  title: v.optional(v.string(), 'default'), count: v.optional(v.number(), 7), flag: v.optional(v.boolean(), true), nullable: v.optional(v.nullable(v.string()), 'default'),
  rows: v.optional(v.array(v.object({ label: v.string(), count: v.number() })), [{ label: 'first', count: 1 }, { label: 'second', count: 2 }])
}) }`
	try {
		const result = await compiler.evaluate(doc, 'report/report.ts', {
			title: '',
			count: 0,
			flag: false,
			nullable: null,
			rows: [{ label: 'provided' }],
		})
		expect(result.data).toEqual({
			title: '',
			count: 0,
			flag: false,
			nullable: null,
			rows: [{ label: 'provided', count: 1 }],
		})
		const empty = await compiler.evaluate(doc, 'report/report.ts', { rows: [] })
		expect(empty.data.rows).toEqual([])
		const defaults = await compiler.evaluate(doc, 'report/report.ts', {})
		expect(defaults.data.rows).toEqual([
			{ label: 'first', count: 1 },
			{ label: 'second', count: 2 },
		])
	} finally {
		await compiler.close()
	}
})

it('retains the TypeScript module path and source range in syntax diagnostics', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	doc.files['report/value.ts'] = 'export const value = ;'
	try {
		await expect(evaluate(compiler, doc)).rejects.toMatchObject({
			code: 'COMPILE_FAILED',
			diagnostics: expect.arrayContaining([
				expect.objectContaining({
					path: 'report/value.ts',
					severity: 'error',
					range: expect.any(Object),
				}),
			]),
		})
	} finally {
		await compiler.close()
	}
})

it.each([
	{
		path: 'report/report.ts',
		invalidSource: 'export const broken = ;',
		repairedSource: source,
		expectedValue: 1,
	},
	{
		path: 'report/value.ts',
		invalidSource: 'export const value = ;',
		repairedSource: 'export const value = 2',
		expectedValue: 2,
	},
])('retains warm $path syntax diagnostics and recovers the same compiler', async (test) => {
	const compiler = new TemplateCompiler()
	const doc = template()
	try {
		const initial = await evaluate(compiler, doc)
		expect(initial.files['/inputs/data.json']).toEqual({ kind: 'json', value: 1 })
		const description = await compiler.describe(doc, 'report/report.ts')
		expect(description).toMatchObject({
			entry: 'report/report.ts',
			template: 'report/main.typ',
			fields: [],
			defaults: {},
		})
		const invalid = {
			...doc,
			revision: '2',
			files: { ...doc.files, [test.path]: test.invalidSource },
		}
		const character = test.invalidSource.indexOf(';')
		await expect.soft(evaluate(compiler, invalid)).rejects.toMatchObject({
			code: 'COMPILE_FAILED',
			diagnostics: expect.arrayContaining([
				expect.objectContaining({
					path: test.path,
					severity: 'error',
					range: {
						start: { line: 0, character },
						end: { line: 0, character: character + 1 },
					},
				}),
			]),
		})
		const repaired = {
			...invalid,
			revision: '3',
			files: { ...invalid.files, [test.path]: test.repairedSource },
		}
		const recovered = await evaluate(compiler, repaired)
		expect(recovered.files['/inputs/data.json']).toEqual({
			kind: 'json',
			value: test.expectedValue,
		})
		expect(await compiler.describe(repaired, 'report/report.ts')).toEqual(description)
	} finally {
		await compiler.close()
	}
})

it('rejects non-JSON transformed output before JSON serialization can discard values', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	doc.files['report/report.ts'] = `import * as v from 'valibot';
export default { template: './main.typ', schema: v.pipe(v.object({}), v.transform(() => ({ omitted: undefined }))) }`
	try {
		await expect(evaluate(compiler, doc)).rejects.toThrow('finite JSON value')
	} finally {
		await compiler.close()
	}
})

it('omits absent optional defaults instead of introducing undefined business data', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	doc.files['report/report.ts'] = `import * as v from 'valibot';
export default { template: './main.typ', schema: v.object({ omitted: v.optional(v.string()), nested: v.object({ omitted: v.optional(v.string()) }) }) }`
	try {
		const result = await compiler.evaluate(doc, 'report/report.ts', {})
		expect(result.data).toEqual({ nested: {} })
		const description = await compiler.describe(doc, 'report/report.ts')
		expect(description.defaults).toEqual({ nested: {} })
	} finally {
		await compiler.close()
	}
})
