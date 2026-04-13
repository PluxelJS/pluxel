import { OpError, toOpError, type AnyOperation, type Infer, type CustomValidator, type OpContext, type OpDescriptor, type OpDoc, type OpErrorCode, type OpExposure, type OpResult, type Operation, type OperationConfig, type Schema, type ValidationIssue } from './types'
import { deepFreeze } from './internal/freeze'
import { compileValidator, deriveParamSpecs, toJsonSchema } from './schema'

type ValidationSpec<T, Ctx extends OpContext> = {
	schema: Schema
	validate: (value: unknown) => { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }
	custom: Array<CustomValidator<T, Ctx>>
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const MAX_TOOL_NAME_LENGTH = 96
const MAX_TITLE_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 240
const MAX_USAGE_LENGTH = 240
const MAX_DETAILS_LENGTH = 4000
const MAX_EXAMPLES = 5
const MAX_TAGS = 8

const nowMs = (ctx?: OpContext) => (typeof ctx?.now === 'number' ? ctx.now : Date.now())

const throwIfStopped = (ctx?: OpContext) => {
	if (!ctx) return
	if (ctx.signal?.aborted) {
		throw new OpError('E_ABORTED', 'Cancelled', {
			details: { reason: (ctx.signal as any).reason },
			cause: (ctx.signal as any).reason,
		})
	}
	const now = nowMs(ctx)
	if (ctx.deadlineMs !== undefined && now > ctx.deadlineMs) {
		throw new OpError('E_TIMEOUT', 'Timeout', { details: { now, deadlineMs: ctx.deadlineMs } })
	}
}

const withSpan = async <T>(
	ctx: OpContext | undefined,
	name: string,
	attrs: Record<string, unknown>,
	fn: () => T | Promise<T>,
): Promise<T> => {
	if (!ctx?.span) return await fn()
	return await ctx.span(name, attrs, fn)
}

const validateWithCustom = async <T, Ctx extends OpContext>(
	spec: ValidationSpec<T, Ctx>,
	value: unknown,
	code: Extract<OpErrorCode, 'E_INPUT_VALIDATION' | 'E_OUTPUT_VALIDATION'>,
	ctx: Ctx,
): Promise<T> => {
	const validated = spec.validate(value)
	if (validated.ok !== true) {
		throw new OpError(code, 'Validation failed', { details: { issues: validated.issues } as any })
	}

	if (spec.custom.length === 0) return validated.value

	const issues: ValidationIssue[] = []
	for (const validate of spec.custom) {
		const result = await validate(validated.value, ctx)
		if (!result) continue
		if (Array.isArray(result)) issues.push(...result)
		else issues.push(result)
	}

	if (issues.length > 0) {
		throw new OpError(code, 'Validation failed', { details: { issues } as any })
	}

	return validated.value
}

const normalizeExposure = (
	exposure: OpExposure | undefined,
): Required<OpExposure> => ({
	rpc: exposure?.rpc === true,
	internal: exposure?.internal === true,
})

const deriveCliUsage = (
	id: string,
	params: OpDescriptor['params'],
	cli: Exclude<OperationConfig<any, any, any>['cli'], false | true | undefined> | undefined,
) => {
	const trigger = cli?.triggers?.[0] ? cli.triggers[0] : id
	const out = [trigger]
	for (const param of params ?? []) {
		const placeholder =
			param.type === 'boolean'
				? `--${param.name}`
				: `--${param.name} <${param.type === 'json' ? 'json' : param.type}>`
		out.push(param.required ? placeholder : `[${placeholder}]`)
	}
	if (cli?.tail) {
		out.push(cli.tail.placeholder ?? (cli.tail.mode === 'json' ? '<json>' : '<text>'))
	}
	return out.join(' ')
}

const normalizeText = (value: string | undefined) => {
	const text = value?.trim()
	return text ? text : undefined
}

const normalizeTextList = (value: string[] | undefined) => {
	if (!Array.isArray(value) || value.length === 0) return undefined
	const out = Array.from(new Set(value.map((entry) => entry.trim()).filter(Boolean)))
	return out.length > 0 ? out : undefined
}

const normalizeDoc = (doc: OpDoc | undefined): OpDoc => {
	const title = normalizeText(doc?.title)
	const description = normalizeText(doc?.description)
	const details = normalizeText(doc?.details)
	const usage = normalizeText(doc?.usage)
	const examples = normalizeTextList(doc?.examples)
	const tags = normalizeTextList(doc?.tags)

	return {
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(details ? { details } : {}),
		...(usage ? { usage } : {}),
		...(examples ? { examples } : {}),
		...(tags ? { tags } : {}),
	}
}

const throwConfigError = (message: string) => {
	throw new OpError('E_INTERNAL', 'Internal error', { message })
}

const requireSingleLine = (label: string, value: string | undefined) => {
	if (!value) return
	if (value.includes('\n')) throwConfigError(`${label} must be a single line`)
}

const requireMaxLength = (label: string, value: string | undefined, maxLength: number) => {
	if (!value) return
	if (value.length > maxLength) throwConfigError(`${label} must be at most ${maxLength} characters`)
}

const validateDocForTool = (doc: OpDoc, id: string) => {
	if (!doc.title) throwConfigError(`Tool-visible op "${id}" must define doc.title`)
	if (!doc.description) throwConfigError(`Tool-visible op "${id}" must define doc.description`)
	requireSingleLine(`doc.title for "${id}"`, doc.title)
	requireSingleLine(`doc.description for "${id}"`, doc.description)
	requireSingleLine(`doc.usage for "${id}"`, doc.usage)
	requireMaxLength(`doc.title for "${id}"`, doc.title, MAX_TITLE_LENGTH)
	requireMaxLength(`doc.description for "${id}"`, doc.description, MAX_DESCRIPTION_LENGTH)
	requireMaxLength(`doc.usage for "${id}"`, doc.usage, MAX_USAGE_LENGTH)
	requireMaxLength(`doc.details for "${id}"`, doc.details, MAX_DETAILS_LENGTH)

	if (doc.examples && doc.examples.length > MAX_EXAMPLES) {
		throwConfigError(`doc.examples for "${id}" must contain at most ${MAX_EXAMPLES} items`)
	}
	for (const example of doc.examples ?? []) {
		requireSingleLine(`doc.examples for "${id}"`, example)
	}

	if (doc.tags && doc.tags.length > MAX_TAGS) {
		throwConfigError(`doc.tags for "${id}" must contain at most ${MAX_TAGS} items`)
	}
	for (const tag of doc.tags ?? []) {
		if (!TAG_PATTERN.test(tag)) {
			throwConfigError(`doc.tags for "${id}" must use lowercase kebab-case tokens`)
		}
	}
}

const validateToolName = (id: string, name: string) => {
	if (name.length > MAX_TOOL_NAME_LENGTH) {
		throwConfigError(`tool.name for "${id}" must be at most ${MAX_TOOL_NAME_LENGTH} characters`)
	}
	if (!TOOL_NAME_PATTERN.test(name)) {
		throwConfigError(
			`tool.name for "${id}" must match ${String(TOOL_NAME_PATTERN)} (lowercase letters, numbers, dot, dash, underscore)`,
		)
	}
}

const validateParamDescriptionsForTool = (
	id: string,
	params: OpDescriptor['params'],
) => {
	for (const param of params ?? []) {
		if (param.description) continue
		throwConfigError(
			`Tool-visible op "${id}" must describe input "${param.inputKey}" in the input schema`,
		)
	}
}

const buildToolGuidance = (
	doc: OpDoc,
	params: OpDescriptor['params'],
) => {
	const parts = [doc.description ?? doc.title ?? '']
	if (doc.details) parts.push(doc.details)
	if (doc.usage) parts.push(`Usage: ${doc.usage}`)
	if (doc.examples?.length) {
		const lines = ['Examples:']
		for (const example of doc.examples) lines.push(`- ${example}`)
		parts.push(lines.join('\n'))
	}
	const describedParams = (params ?? []).filter((param) => param.description)
	if (describedParams.length > 0) {
		const lines = ['Inputs:']
		for (const param of describedParams) {
			lines.push(
				`- ${param.inputKey} (${param.type}${param.required ? ', required' : ', optional'}): ${param.description}`,
			)
		}
		parts.push(lines.join('\n'))
	}
	return parts.filter(Boolean).join('\n\n')
}

const compileDescriptor = (
	config: OperationConfig<any, any, any>,
): OpDescriptor => {
	const exposure = normalizeExposure(config.exposure)
	if (exposure.internal && (exposure.rpc || Boolean(config.cli) || Boolean(config.tool))) {
		throwConfigError(`Internal op "${config.id}" cannot declare rpc, cli, or tool exposure`)
	}
	const doc = normalizeDoc(config.doc)
	const inputSchema = toJsonSchema(config.input)
	const outputSchema = config.output ? toJsonSchema(config.output) : undefined
	const params = deriveParamSpecs(config.input)

	const descriptor: OpDescriptor = {
		id: config.id,
		doc,
		exposure,
		policy: { ...config.policy },
		schemas: {
			input: inputSchema,
			...(outputSchema ? { output: outputSchema } : {}),
		},
		transports: {},
		...(params ? { params } : {}),
	}

	if (config.cli) {
		const cliConfig = config.cli === true ? undefined : config.cli
		const triggers =
			Array.isArray(cliConfig?.triggers) && cliConfig.triggers.length > 0
				? Array.from(new Set(cliConfig.triggers.map((entry) => String(entry).trim()).filter(Boolean)))
				: [config.id]
		descriptor.transports.cli = {
			triggers,
			...(cliConfig?.tail ? { tail: cliConfig.tail } : {}),
			usage: doc.usage || deriveCliUsage(config.id, params, cliConfig),
		}
	}

	if (config.tool) {
		const toolConfig = config.tool === true ? undefined : config.tool
		const name = toolConfig?.name?.trim() || config.id
		validateToolName(config.id, name)
		validateDocForTool(doc, config.id)
		validateParamDescriptionsForTool(config.id, params)
		const inputHints =
			params && params.length > 0
				? params.map((param) => ({
						key: param.inputKey,
						type: param.type,
						required: param.required,
						...(param.description ? { description: param.description } : {}),
					}))
				: undefined
		descriptor.transports.tool = {
			id: config.id,
			name,
			title: doc.title || name,
			description: doc.description || doc.title || name,
			guidance: buildToolGuidance(doc, params),
			...(doc.details ? { details: doc.details } : {}),
			...(doc.usage ? { usage: doc.usage } : {}),
			...(doc.examples ? { examples: [...doc.examples] } : {}),
			...(doc.tags ? { tags: [...doc.tags] } : {}),
			...(inputHints ? { inputHints } : {}),
			inputSchema: descriptor.schemas.input,
			...(descriptor.schemas.output ? { outputSchema: descriptor.schemas.output } : {}),
		}
	}

	return deepFreeze(descriptor)
}

const normalizeError = (ctx: OpContext | undefined, error: unknown): OpError => {
	if (error instanceof OpError) return error
	const classified = ctx?.classifyError?.(error)
	if (classified) return classified
	return toOpError(error, 'E_INTERNAL', 'Operation failed')
}

type CompiledInterceptors<Ctx extends OpContext> = {
	count: number
	before: Array<{ idx: number; fn: NonNullable<OperationConfig<any, any, Ctx>['interceptors']>[number]['before'] }>
	afterInput: Array<{ idx: number; fn: NonNullable<OperationConfig<any, any, Ctx>['interceptors']>[number]['afterInput'] }>
	afterOutputRev: Array<{ idx: number; fn: NonNullable<OperationConfig<any, any, Ctx>['interceptors']>[number]['afterOutput'] }>
	onErrorRev: Array<{
		idx: number
		fn: NonNullable<OperationConfig<any, any, Ctx>['interceptors']>[number]['onError']
		canRecover: boolean
	}>
	finallyRev: Array<{ idx: number; fn: NonNullable<OperationConfig<any, any, Ctx>['interceptors']>[number]['finally'] }>
}

const compileInterceptors = <Ctx extends OpContext>(
	interceptors: NonNullable<OperationConfig<any, any, Ctx>['interceptors']>,
): CompiledInterceptors<Ctx> => {
	const before: CompiledInterceptors<Ctx>['before'] = []
	const afterInput: CompiledInterceptors<Ctx>['afterInput'] = []
	const afterOutputRev: CompiledInterceptors<Ctx>['afterOutputRev'] = []
	const onErrorRev: CompiledInterceptors<Ctx>['onErrorRev'] = []
	const finallyRev: CompiledInterceptors<Ctx>['finallyRev'] = []

	for (let idx = 0; idx < interceptors.length; idx += 1) {
		const current = interceptors[idx]!
		if (current.before) before.push({ idx, fn: current.before })
		if (current.afterInput) afterInput.push({ idx, fn: current.afterInput })
		if (current.afterOutput) afterOutputRev.push({ idx, fn: current.afterOutput })
		if (current.onError) onErrorRev.push({ idx, fn: current.onError, canRecover: current.canRecover === true })
		if (current.finally) finallyRev.push({ idx, fn: current.finally })
	}

	afterOutputRev.reverse()
	onErrorRev.reverse()
	finallyRev.reverse()

	return { count: interceptors.length, before, afterInput, afterOutputRev, onErrorRev, finallyRev }
}

const runFinally = async <Ctx extends OpContext>(
	compiled: CompiledInterceptors<Ctx>,
	states: readonly unknown[],
	summary: { ok: boolean; durationMs: number; err?: OpError },
	ctx: Ctx,
) => {
	for (const current of compiled.finallyRev) {
		try {
			await current.fn(ctx, summary, states[current.idx])
		} catch {}
	}
}

export const defineOp = <
	SIn extends Schema,
	SOut extends Schema | undefined = undefined,
	Ctx extends OpContext = OpContext,
>(
	config: Omit<
		OperationConfig<Infer<SIn>, SOut extends Schema ? Infer<SOut> : unknown, Ctx>,
		'input' | 'output'
	> & {
		input: SIn
		output?: SOut
	},
): Operation<Infer<SIn>, SOut extends Schema ? Infer<SOut> : unknown, Ctx> => {
	type I = Infer<SIn>
	type O = SOut extends Schema ? Infer<SOut> : unknown

	const inputSpec: ValidationSpec<I, Ctx> = {
		schema: config.input,
		validate: compileValidator(config.input) as ValidationSpec<I, Ctx>['validate'],
		custom: [...(config.validateInput ?? [])],
	}
	const outputSpec: ValidationSpec<O, Ctx> | undefined = config.output
		? {
				schema: config.output,
				validate: compileValidator(config.output) as ValidationSpec<O, Ctx>['validate'],
				custom: [...(config.validateOutput ?? [])],
			}
		: undefined
	const descriptor = compileDescriptor(config)
	const interceptors = compileInterceptors(config.interceptors ?? [])

	const run = async (candidate: unknown, ctx?: Ctx): Promise<O> => {
		const currentCtx = (ctx ?? {}) as Ctx
		const start = nowMs(currentCtx)
		const states = Array.from<unknown>({ length: interceptors.count })
		let ok = false
		let finalError: OpError | undefined

		try {
			throwIfStopped(currentCtx)

			let currentCandidate = candidate
			let shortCircuit: { outputCandidate: unknown } | undefined

			await withSpan(currentCtx, 'ops.before', { id: config.id }, async () => {
				for (const current of interceptors.before) {
					throwIfStopped(currentCtx)
					const result = (await current.fn(currentCtx, currentCandidate)) ?? { kind: 'continue' }
					states[current.idx] = result.state
					if (result.kind === 'shortCircuit') {
						shortCircuit = { outputCandidate: result.outputCandidate }
						return
					}
					if ('candidate' in result) currentCandidate = result.candidate
				}
			})

			let inputValue: I | undefined
			if (!shortCircuit) {
				inputValue = await validateWithCustom(inputSpec, currentCandidate, 'E_INPUT_VALIDATION', currentCtx)
				await withSpan(currentCtx, 'ops.afterInput', { id: config.id }, async () => {
					for (const current of interceptors.afterInput) {
						throwIfStopped(currentCtx)
						await current.fn(currentCtx, inputValue, states[current.idx])
					}
				})
			}

			let outputCandidate: unknown = shortCircuit
				? shortCircuit.outputCandidate
				: await withSpan(currentCtx, 'ops.execute', { id: config.id }, async () =>
						await config.execute(inputValue as I, currentCtx),
					)

			await withSpan(currentCtx, 'ops.afterOutput', { id: config.id }, async () => {
				for (const current of interceptors.afterOutputRev) {
					throwIfStopped(currentCtx)
					const result = await current.fn(currentCtx, outputCandidate, states[current.idx])
					if (result && typeof result === 'object' && result.kind === 'transform') {
						outputCandidate = result.outputCandidate
					}
				}
			})

			const finalOutput = outputSpec
				? await validateWithCustom(outputSpec, outputCandidate, 'E_OUTPUT_VALIDATION', currentCtx)
				: (outputCandidate as O)
			ok = true
			return finalOutput
		} catch (error) {
			const normalized = normalizeError(currentCtx, error)
			finalError = normalized

			for (const current of interceptors.onErrorRev) {
				throwIfStopped(currentCtx)
				const result = await current.fn(currentCtx, normalized, states[current.idx])
				if (!result || typeof result !== 'object' || result.kind !== 'recover' || !current.canRecover) {
					continue
				}

				let outputCandidate = result.outputCandidate
				for (const after of interceptors.afterOutputRev) {
					throwIfStopped(currentCtx)
					const transformed = await after.fn(currentCtx, outputCandidate, states[after.idx])
					if (transformed && typeof transformed === 'object' && transformed.kind === 'transform') {
						outputCandidate = transformed.outputCandidate
					}
				}

				const recovered = outputSpec
					? await validateWithCustom(outputSpec, outputCandidate, 'E_OUTPUT_VALIDATION', currentCtx)
					: (outputCandidate as O)

				ok = true
				finalError = undefined
				if (normalized.kind === 'fault') {
					try {
						await currentCtx.onFault?.({
							id: config.id,
							err: normalized,
							durationMs: nowMs(currentCtx) - start,
							recovered: true,
						})
					} catch {}
				}
				return recovered
			}

			if (normalized.kind === 'fault') {
				try {
					await currentCtx.onFault?.({
						id: config.id,
						err: normalized,
						durationMs: nowMs(currentCtx) - start,
						recovered: false,
					})
				} catch {}
			}
			throw normalized
		} finally {
			await runFinally(interceptors, states, { ok, durationMs: nowMs(ctx) - start, ...(finalError ? { err: finalError } : {}) }, (ctx ?? {}) as Ctx)
		}
	}

	return {
		id: config.id,
		inputSchema: config.input,
		...(config.output ? { outputSchema: config.output } : {}),
		descriptor,
		run,
		async runSafe(candidate: unknown, ctx?: Ctx): Promise<OpResult<O>> {
			try {
				return { ok: true, value: await run(candidate, ctx) }
			} catch (error) {
				return { ok: false, error: normalizeError(ctx, error) }
			}
		},
	}
}

export const isOperation = (value: unknown): value is AnyOperation =>
	!!value &&
	typeof value === 'object' &&
	typeof (value as AnyOperation).id === 'string' &&
	typeof (value as AnyOperation).run === 'function'
