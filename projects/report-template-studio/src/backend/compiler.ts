import { posix } from 'node:path'
import { pathName, reportEntry } from './storage-validation.js'
import type { FieldNode } from 'valibot-form'
import type { TypstFiles } from '@pluxel/typst'
import type { WorkspaceSnapshot } from '../shared/contracts.js'
import { TemplateRuntime } from './template-runtime.js'
import { inputData } from './inputs.js'

type EvaluatedTemplate = {
	entry: string
	template: string
	name: string
	fields: FieldNode[]
	data: Record<string, unknown>
	files: TypstFiles
}

/** Active templates own separate Vite graphs and QuickJS runners. */
export class TemplateCompiler {
	private readonly runtimes = new Map<string, TemplateRuntime>()
	private closed = false
	async evaluate(
		document: WorkspaceSnapshot,
		entry: string,
		input: Record<string, unknown> = {},
	): Promise<EvaluatedTemplate> {
		if (this.closed) throw new Error('Template compiler is closed')
		if (!Object.hasOwn(document.files, entry) || !reportEntry(entry))
			throw new Error('entry 必须指向工作区中的同名目录入口 folder/folder.ts')
		const data = inputData(input)
		const id = JSON.stringify([document.project.id, entry])
		const source = { files: document.files, entry }
		let runtime = this.runtimes.get(id)
		try {
			if (!runtime) {
				if (this.runtimes.size >= 4) {
					const [oldestId, oldest] = this.runtimes.entries().next().value!
					this.runtimes.delete(oldestId)
					await oldest.close()
				}
				runtime = await TemplateRuntime.open(source)
				this.runtimes.set(id, runtime)
			}
			await runtime.update(source)
			const json = await runtime.run(data)
			if (typeof json !== 'string' || json.length > 4 * 1024 * 1024)
				throw new Error('模板输出过大或不是 JSON')
			return validateOutput(document, entry, JSON.parse(json))
		} catch (cause) {
			this.runtimes.delete(id)
			await runtime?.close().catch(() => {})
			const failure = new Error(
				`模板执行失败：${cause instanceof Error ? cause.message : JSON.stringify(cause)}`,
				{ cause },
			)
			if (cause instanceof Error && 'fields' in cause && Array.isArray(cause.fields))
				Object.assign(failure, { fields: cause.fields, data: 'data' in cause ? cause.data : data })
			throw failure
		}
	}
	async remove(id: string) {
		for (const [key, runtime] of this.runtimes) {
			if (JSON.parse(key)[0] !== id) continue
			this.runtimes.delete(key)
			await runtime.close()
		}
	}
	async close() {
		if (this.closed) return
		this.closed = true
		const results: PromiseSettledResult<void>[] = []
		for (const runtime of this.runtimes.values()) {
			try {
				await runtime.close()
				results.push({ status: 'fulfilled', value: undefined })
			} catch (reason) {
				results.push({ status: 'rejected', reason })
			}
		}
		this.runtimes.clear()
		const failures = results.filter((result) => result.status === 'rejected')
		if (failures.length > 0)
			throw new AggregateError(
				failures.map((result) => result.reason),
				'Template compilers failed to close',
			)
	}
}

/** Standalone evaluation owns and closes its compiler; Studio retains its compiler generation. */
export async function evaluateTemplate(
	document: WorkspaceSnapshot,
	entry: string,
): Promise<EvaluatedTemplate> {
	const compiler = new TemplateCompiler()
	try {
		return await compiler.evaluate(document, entry)
	} finally {
		await compiler.close()
	}
}

function validateOutput(
	document: WorkspaceSnapshot,
	entry: string,
	result: unknown,
): EvaluatedTemplate {
	if (!result || typeof result !== 'object') throw new Error('模板输出必须是对象')
	const output = result as Record<string, unknown>
	if (
		typeof output.template !== 'string' ||
		!output.template ||
		output.template.startsWith('/') ||
		output.template.includes('\\')
	)
		throw new Error('template 必须是相对入口的 .typ 路径')
	const template = pathName(posix.join(posix.dirname(entry), output.template))
	if (!template.endsWith('.typ') || !Object.hasOwn(document.files, template))
		throw new Error('template 必须指向工作区中的 .typ 文件')
	if (!Array.isArray(output.fields)) throw new Error('表单 schema 必须是 object')
	if (typeof output.inputError === 'string')
		throw Object.assign(new Error(output.inputError), { fields: output.fields, data: output.data })
	if (!output.files || typeof output.files !== 'object' || Array.isArray(output.files))
		throw new Error('createFiles 必须返回文件表')
	const files = output.files as Record<string, unknown>
	if (Object.keys(files).length > 256) throw new Error('输入文件不能超过 256 个')
	for (const [name, value] of Object.entries(files)) {
		if (
			!/^\/inputs\/(?!.*(?:^|\/)\.\.?\/)[^\\]+$/.test(name) ||
			name
				.split('/')
				.slice(2)
				.some((p) => !p || p === '.' || p === '..')
		)
			throw new Error(`无效输入路径：${name}`)
		if (!value || typeof value !== 'object') throw new Error(`无效输入文件：${name}`)
		const resource = value as Record<string, unknown>
		if (resource.kind === 'json' && Object.hasOwn(resource, 'value')) continue
		if (resource.kind === 'text' && typeof resource.text === 'string') continue
		throw new Error(`生成的输入仅支持 json/text：${name}`)
	}
	return {
		entry,
		template,
		name: posix.basename(entry, '.ts'),
		fields: output.fields as FieldNode[],
		data: output.data as Record<string, unknown>,
		files: files as TypstFiles,
	}
}
