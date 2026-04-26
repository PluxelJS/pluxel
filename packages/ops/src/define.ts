import { compileDescriptor, compileRuntime } from './compile'
import { attachOperationRuntime } from './internal/runtime'
import { compileValidator } from './schema'
import {
	OpError,
	toOpError,
	type AnyOperation,
	type CustomValidator,
	type Infer,
	type OpContext,
	type OpErrorCode,
	type OpResult,
	type Operation,
	type OperationConfig,
	type Schema,
	type ValidationIssue,
} from './types'

type ValidationSpec<T, Ctx extends OpContext> = {
	validate: (value: unknown) => { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }
	custom: Array<CustomValidator<T, Ctx>>
}

const nowMs = (ctx?: OpContext) => (typeof ctx?.now === 'number' ? ctx.now : Date.now())

const throwIfStopped = (ctx?: OpContext) => {
	if (!ctx) return
	if (ctx.signal?.aborted) {
		throw new OpError('E_ABORTED', 'Cancelled', {
			details: { reason: ctx.signal.reason },
			cause: ctx.signal.reason,
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
		throw new OpError(code, 'Validation failed', { details: { issues: validated.issues } })
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
		throw new OpError(code, 'Validation failed', { details: { issues } })
	}

	return validated.value
}

const normalizeError = (ctx: OpContext | undefined, error: unknown): OpError => {
	if (error instanceof OpError) return error
	const classified = ctx?.classifyError?.(error)
	if (classified) return classified
	return toOpError(error, 'E_INTERNAL', 'Operation failed')
}

export const defineOp = <
	SIn extends Schema,
	SOut extends Schema,
	Ctx extends OpContext = OpContext,
>(
	config: Omit<OperationConfig<Infer<SIn>, Infer<SOut>, Ctx>, 'input' | 'output'> & {
		input: SIn
		output: SOut
	},
): Operation<Infer<SIn>, Infer<SOut>, Ctx> => {
	type I = Infer<SIn>
	type O = Infer<SOut>

	const inputSpec: ValidationSpec<I, Ctx> = {
		validate: compileValidator(config.input) as ValidationSpec<I, Ctx>['validate'],
		custom: [...(config.validateInput ?? [])],
	}
	const outputSpec: ValidationSpec<O, Ctx> = {
		validate: compileValidator(config.output) as ValidationSpec<O, Ctx>['validate'],
		custom: [...(config.validateOutput ?? [])],
	}
	const descriptor = compileDescriptor(config)
	const runtime = compileRuntime(config)

	const run = async (candidate: unknown, ctx?: Ctx): Promise<O> => {
		const currentCtx = (ctx ?? {}) as Ctx
		const start = nowMs(currentCtx)

		try {
			throwIfStopped(currentCtx)
			const inputValue = await validateWithCustom(
				inputSpec,
				candidate,
				'E_INPUT_VALIDATION',
				currentCtx,
			)
			const outputCandidate = await withSpan(
				currentCtx,
				'ops.execute',
				{ id: config.id },
				async () => await config.execute(inputValue, currentCtx),
			)
			return await validateWithCustom(
				outputSpec,
				outputCandidate,
				'E_OUTPUT_VALIDATION',
				currentCtx,
			)
		} catch (error) {
			const normalized = normalizeError(currentCtx, error)
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
		}
	}

	const op: Operation<I, O, Ctx> = {
		id: config.id,
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
	return attachOperationRuntime(op, runtime)
}

export const isOperation = (value: unknown): value is AnyOperation =>
	!!value &&
	typeof value === 'object' &&
	typeof (value as AnyOperation).id === 'string' &&
	typeof (value as AnyOperation).run === 'function'
