import { compileDescriptor } from './compile'
import { compileValidator } from './schema'
import {
	OpError,
	toOpError,
	type AnyOperation,
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
	custom?: (
		value: T,
		ctx: Ctx,
	) => ReturnType<NonNullable<OperationConfig<T, unknown, Ctx>['validate']>>
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

	if (!spec.custom) return validated.value

	const issues: ValidationIssue[] = []
	const result = await spec.custom(validated.value, ctx)
	if (result) {
		if (Array.isArray(result)) issues.push(...result)
		else issues.push(result)
	}
	if (issues.length > 0) {
		throw new OpError(code, 'Validation failed', { details: { issues } })
	}

	return validated.value
}

const normalizeError = (error: unknown): OpError => {
	if (error instanceof OpError) return error
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
		...(config.validate ? { custom: config.validate } : {}),
	}
	const outputSpec: ValidationSpec<O, Ctx> = {
		validate: compileValidator(config.output) as ValidationSpec<O, Ctx>['validate'],
		...(config.validateOutput ? { custom: config.validateOutput } : {}),
	}
	const descriptor = compileDescriptor(config)

	const invokeRaw = async (candidate: unknown, ctx?: Ctx): Promise<O> => {
		const currentCtx = (ctx ?? {}) as Ctx

		try {
			throwIfStopped(currentCtx)
			const inputValue = await validateWithCustom(
				inputSpec,
				candidate,
				'E_INPUT_VALIDATION',
				currentCtx,
			)
			const outputCandidate = await config.run(inputValue, currentCtx)
			return await validateWithCustom(
				outputSpec,
				outputCandidate,
				'E_OUTPUT_VALIDATION',
				currentCtx,
			)
		} catch (error) {
			const normalized = normalizeError(error)
			throw normalized
		}
	}

	const op: Operation<I, O, Ctx> = {
		id: config.id,
		descriptor,
		run: config.run,
		invokeRaw,
		async invoke(candidate: unknown, ctx?: Ctx): Promise<OpResult<O>> {
			try {
				return { ok: true, value: await invokeRaw(candidate, ctx) }
			} catch (error) {
				return { ok: false, error: normalizeError(error) }
			}
		},
	}
	return op
}

export const isOperation = (value: unknown): value is AnyOperation =>
	!!value &&
	typeof value === 'object' &&
	typeof (value as AnyOperation).id === 'string' &&
	typeof (value as AnyOperation).invoke === 'function' &&
	typeof (value as AnyOperation).invokeRaw === 'function'
