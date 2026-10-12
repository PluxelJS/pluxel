import { posix } from 'node:path'
import type { FieldNode } from 'valibot-form'
import type { TypstFiles } from '@pluxel/typst'
import type { JsonObject, StudioError, WorkspaceSnapshot } from '../shared/contracts.js'
import { pathName, reportEntry } from './storage-validation.js'
import { TemplateRuntime, type RuntimeOperation } from './template-runtime.js'
import { inputData } from './inputs.js'

type EvaluatedTemplate = {
	entry: string
	template: string
	name: string
	data: JsonObject
	files: TypstFiles
}
type DescribedTemplate = {
	entry: string
	template: string
	name: string
	fields: FieldNode[]
	defaults: JsonObject
}

/** A document record owns this compiler and its sole Vite graph/QuickJS runner. */
export class TemplateCompiler {
	private runtime?: TemplateRuntime
	private identity?: string
	private closed = false
	private closing?: Promise<void>
	async evaluate(
		document: WorkspaceSnapshot,
		entry: string,
		input: JsonObject,
		options: RuntimeOperation = {},
	): Promise<EvaluatedTemplate> {
		const data = inputData(input)
		const output = await this.invoke(document, entry, options, (runtime) =>
			runtime.run(data, options),
		)
		const metadata = validateMetadata(document, entry, output)
		if (Array.isArray(output.issues)) {
			const issues = output.issues as NonNullable<StudioError['issues']>
			throw Object.assign(new Error('模板输入未通过 schema 校验'), {
				code: 'INVALID_INPUT',
				issues,
			})
		}
		if (!output.files || typeof output.files !== 'object' || Array.isArray(output.files))
			throw new Error('createFiles 必须返回文件表')
		const files = output.files as Record<string, unknown>
		if (Object.keys(files).length > 256)
			throw Object.assign(new Error('输入文件不能超过 256 个'), { code: 'LIMIT_EXCEEDED' })
		for (const [name, value] of Object.entries(files)) {
			if (
				!/^\/inputs\/(?!.*(?:^|\/)\.\.?\/)[^\\]+$/.test(name) ||
				name
					.split('/')
					.slice(2)
					.some((part) => !part || part === '.' || part === '..')
			)
				throw Object.assign(new Error(`无效输入路径：${name}`), { code: 'INVALID_INPUT' })
			if (!value || typeof value !== 'object') throw new Error(`无效输入文件：${name}`)
			const resource = value as Record<string, unknown>
			if (resource.kind === 'json' && Object.hasOwn(resource, 'value')) continue
			if (resource.kind === 'text' && typeof resource.text === 'string') continue
			throw new Error(`生成的输入仅支持 json/text：${name}`)
		}
		return { ...metadata, data: inputData(output.data), files: files as TypstFiles }
	}
	async describe(
		document: WorkspaceSnapshot,
		entry: string,
		options: RuntimeOperation = {},
	): Promise<DescribedTemplate> {
		const output = await this.invoke(document, entry, options, (runtime) =>
			runtime.describe(options),
		)
		const metadata = validateMetadata(document, entry, output)
		if (!Array.isArray(output.fields)) throw new Error('表单 schema 必须是 object')
		return {
			...metadata,
			fields: output.fields as FieldNode[],
			defaults: inputData(output.defaults),
		}
	}
	private async invoke(
		document: WorkspaceSnapshot,
		entry: string,
		options: RuntimeOperation,
		run: (runtime: TemplateRuntime) => Promise<unknown>,
	): Promise<Record<string, unknown>> {
		if (this.closed)
			throw Object.assign(new Error('Template compiler is closed'), { code: 'CLOSED' })
		if (!Object.hasOwn(document.files, entry) || !reportEntry(entry))
			throw Object.assign(new Error('entry 必须指向工作区中的同名目录入口 folder/folder.ts'), {
				code: 'INVALID_INPUT',
			})
		const identity = JSON.stringify([document.project.id, entry])
		if (this.identity && this.identity !== identity)
			throw new Error('Template compiler belongs to a different document')
		this.identity = identity
		const source = { files: document.files, entry }
		try {
			this.runtime ??= await TemplateRuntime.open(source, options)
			await this.runtime.update(source, options)
			const json = await run(this.runtime)
			if (typeof json !== 'string' || Buffer.byteLength(json) > 4 * 1024 * 1024)
				throw Object.assign(new Error('模板输出过大或不是 JSON'), { code: 'LIMIT_EXCEEDED' })
			const output: unknown = JSON.parse(json)
			if (!output || typeof output !== 'object' || Array.isArray(output))
				throw new Error('模板输出必须是对象')
			return output as Record<string, unknown>
		} catch (cause) {
			const runtime = this.runtime
			this.runtime = undefined
			const failure = options.signal?.aborted
				? options.signal.reason
				: Object.assign(
						new Error(
							`模板执行失败：${cause instanceof Error ? cause.message : JSON.stringify(cause)}`,
							{ cause },
						),
						{
							code:
								cause && typeof cause === 'object' && 'code' in cause
									? cause.code
									: 'COMPILE_FAILED',
							...(cause && typeof cause === 'object' && 'diagnostics' in cause
								? { diagnostics: cause.diagnostics }
								: {}),
						},
					)
			try {
				await runtime?.close()
			} catch (cleanup) {
				throw Object.assign(
					new AggregateError([failure, cleanup], 'Template evaluation and cleanup failed', {
						cause: failure,
					}),
					{
						code: failure?.code,
						diagnostics: failure?.diagnostics,
					},
				)
			}
			throw failure
		}
	}
	close(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		const runtime = this.runtime
		this.runtime = undefined
		return (this.closing = (async () => {
			await runtime?.close()
		})())
	}
}

function validateMetadata(
	document: WorkspaceSnapshot,
	entry: string,
	output: Record<string, unknown>,
) {
	if (
		typeof output.template !== 'string' ||
		!output.template ||
		output.template.startsWith('/') ||
		output.template.includes('\\')
	)
		throw Object.assign(new Error('template 必须是相对入口的 .typ 路径'), { code: 'INVALID_INPUT' })
	let template: string
	try {
		template = pathName(posix.join(posix.dirname(entry), output.template))
	} catch (cause) {
		throw Object.assign(new Error('Invalid workspace path for template', { cause }), {
			code: 'INVALID_INPUT',
		})
	}
	if (!template.endsWith('.typ') || !Object.hasOwn(document.files, template))
		throw Object.assign(new Error('template 必须指向工作区中的 .typ 文件'), {
			code: 'INVALID_INPUT',
		})
	return { entry, template, name: posix.basename(entry, '.ts') }
}
