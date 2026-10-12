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
	return compiler.evaluate(doc, 'report/report.ts')
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
	const first = template('one')
	const second = template('two')
	try {
		await evaluate(compiler, first)
		await evaluate(compiler, second)
		const next = {
			...first,
			files: { ...first.files, 'report/value.ts': 'export const value = 3' },
		}
		const updated = await evaluate(compiler, next)
		expect(updated.files['/inputs/data.json']).toEqual({ kind: 'json', value: 3 })
		const untouched = await evaluate(compiler, second)
		expect(untouched.files['/inputs/data.json']).toEqual({ kind: 'json', value: 1 })
	} finally {
		await compiler.close()
	}
})

it('preserves official hot.data/dispose through indirect dependency and shared Typst updates', async () => {
	const compiler = new TemplateCompiler()
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
		await compiler.remove(doc.project.id)
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

it('returns the new schema fields when an added required input has no value yet', async () => {
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
			fields: expect.arrayContaining([expect.objectContaining({ name: 'required' })]),
		})
		const recovered = await compiler.evaluate(next, 'report/report.ts', { required: 'provided' })
		expect(recovered.fields).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'required' })]),
		)
	} finally {
		await compiler.close()
	}
})

it('merges recursive defaults and isolates report input within one workspace', async () => {
	const compiler = new TemplateCompiler()
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
		const second = await compiler.evaluate(doc, 'second/second.ts')
		expect(second.data).toEqual({ nested: { title: 'Default', amount: 1 } })
		expect(second.name).toBe('second')
		expect(second.files['/inputs/data.json']).toEqual({ kind: 'json', value: second.data })
	} finally {
		await compiler.close()
	}
})
it('rejects ordinary files, missing exports and escaped template paths, then recovers', async () => {
	const compiler = new TemplateCompiler()
	const doc = template()
	try {
		await expect(compiler.evaluate(doc, 'report/main.typ')).rejects.toThrow('folder/folder.ts')
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
				),
			).rejects.toThrow('模板执行失败')
		}
		const result = await compiler.evaluate(doc, 'report/report.ts')
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
	try {
		const letter = await compiler.evaluate(doc, '报表/银行询证函/银行询证函.ts')
		expect(letter.files['/inputs/data.json']).toMatchObject({
			kind: 'json',
			value: { header: { companyName: '示例有限公司' }, accounts: [{ name: '银行存款' }] },
		})
		expect(letter.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'body', meta: expect.objectContaining({ label: '正文' }) }),
			]),
		)
		const summary = await compiler.evaluate(doc, '报表/银行账户余额汇总表/银行账户余额汇总表.ts', {
			header: { companyName: '外部业务数据' },
		})
		expect(summary.files['/inputs/data.json']).toMatchObject({
			kind: 'json',
			value: { header: { companyName: '外部业务数据', currency: '人民币' } },
		})
		expect(summary.fields.some((field) => field.name === 'body')).toBe(false)
	} finally {
		await compiler.close()
	}
})
