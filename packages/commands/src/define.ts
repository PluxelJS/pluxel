import { Result, type Result as BetterResult } from 'better-result'
import { compileCommand } from './compile'
import { isCommandResult } from './internal/result'
import {
	type Command,
	type CommandContext,
	type CommandContextArgs,
	type CommandFailure,
	type DefineCommandConfig,
	type Infer,
	type ObjectSchema,
	type ValidationIssue,
	type Wire,
} from './types'

const cancellationCode = new WeakMap<AbortSignal, 'ABORTED' | 'TIMEOUT'>()
const cancellationReasonCode = new WeakMap<object, 'TIMEOUT'>()
const maxTimerDelayMs = 2_147_483_647

function codeForSignal(signal: AbortSignal): 'ABORTED' | 'TIMEOUT' {
	const direct = cancellationCode.get(signal)
	if (direct) return direct
	const reason = signal.reason
	if (reason && (typeof reason === 'object' || typeof reason === 'function')) {
		const inherited = cancellationReasonCode.get(reason)
		if (inherited) return inherited
	}
	return 'ABORTED'
}

function failure(code: CommandFailure['code'], message: string, cause?: unknown): CommandFailure {
	return { code, message, ...(cause === undefined ? {} : { cause }) } as CommandFailure
}

function inputFailure(issues: readonly ValidationIssue[], cause?: unknown): CommandFailure {
	return {
		code: 'INPUT_VALIDATION',
		message: 'Invalid command input',
		issues: issues.map(({ path, code, message }) => ({
			...(path ? { path } : {}),
			...(code ? { code } : {}),
			message,
		})),
		...(cause === undefined ? {} : { cause }),
	}
}

function cancellation(context: CommandContext): CommandFailure | undefined {
	if (context.signal?.aborted) {
		return failure(codeForSignal(context.signal), 'Command cancelled', context.signal.reason)
	}
	if (context.deadlineMs !== undefined && Date.now() >= context.deadlineMs) {
		return failure('TIMEOUT', 'Command timed out')
	}
	return undefined
}

function invocationContext<Ctx extends CommandContext>(
	context: Ctx,
): {
	context: Ctx
	cleanup: () => void
	error?: CommandFailure
} {
	if (context.deadlineMs !== undefined && !Number.isFinite(context.deadlineMs)) {
		return {
			context,
			cleanup: () => {},
			error: failure('INTERNAL', 'Invalid command context deadline'),
		}
	}
	const existing = cancellation(context)
	if (existing) return { context, cleanup: () => {}, error: existing }
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const abortCaller = () => {
		if (controller.signal.aborted) return
		cancellationCode.set(controller.signal, codeForSignal(context.signal!))
		controller.abort(context.signal?.reason)
	}
	context.signal?.addEventListener('abort', abortCaller, { once: true })
	if (context.signal?.aborted) abortCaller()
	if (context.deadlineMs !== undefined) {
		const deadlineMs = context.deadlineMs
		const scheduleDeadline = () => {
			if (controller.signal.aborted) return
			const remainingMs = deadlineMs - Date.now()
			if (remainingMs <= 0) {
				const reason = new Error('Command deadline reached')
				cancellationCode.set(controller.signal, 'TIMEOUT')
				cancellationReasonCode.set(reason, 'TIMEOUT')
				controller.abort(reason)
				return
			}
			timer = setTimeout(scheduleDeadline, Math.min(remainingMs, maxTimerDelayMs))
		}
		scheduleDeadline()
	}
	const composed = { ...context, signal: controller.signal } as Ctx
	return {
		context: composed,
		cleanup: () => {
			context.signal?.removeEventListener('abort', abortCaller)
			if (timer) clearTimeout(timer)
		},
	}
}

export function defineCommand<
	SIn extends ObjectSchema,
	O,
	Ctx extends CommandContext = CommandContext,
>(config: DefineCommandConfig<SIn, O, Ctx>): Command<Wire<SIn>, O, Ctx> {
	const compiled = compileCommand(config)
	const implementation = config.execute
	const name = compiled.descriptor.name
	const descriptor = compiled.descriptor
	async function execute(
		candidate: Wire<SIn>,
		...args: CommandContextArgs<Ctx>
	): Promise<BetterResult<O, CommandFailure>> {
		let call: ReturnType<typeof invocationContext<Ctx>>
		try {
			call = invocationContext((args[0] ?? {}) as Ctx)
		} catch (error) {
			return Result.err(failure('INTERNAL', 'Invalid command context', error))
		}
		if (call.error) return Result.err(call.error)
		try {
			const prior = cancellation(call.context)
			if (prior) return Result.err(prior)
			const validated = compiled.input.validateInput(candidate)
			if (validated.ok !== true) return Result.err(inputFailure(validated.issues))
			let decoded: Infer<SIn>
			try {
				decoded = compiled.input.decode(validated.value)
			} catch (error) {
				return Result.err(
					inputFailure(
						[
							{
								message: 'Input could not be decoded',
								code: 'codec_decode',
							},
						],
						error,
					),
				)
			}
			const beforeHandler = cancellation(call.context)
			if (beforeHandler) return Result.err(beforeHandler)
			let output: unknown
			try {
				output = await implementation(decoded, call.context)
			} catch (error) {
				if (call.context.signal?.aborted && error === call.context.signal.reason) {
					return Result.err(cancellation(call.context)!)
				}
				return Result.err(failure('INTERNAL', 'Command failed', error))
			}
			if (isCommandResult(output)) return output as BetterResult<O, CommandFailure>
			return Result.err(failure('INTERNAL', 'Command returned an invalid Result', output))
		} catch (error) {
			return Result.err(failure('INTERNAL', 'Command failed', error))
		} finally {
			call.cleanup()
		}
	}
	return Object.freeze({ name, descriptor, execute })
}
