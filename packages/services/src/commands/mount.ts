import {
	CommandError,
	Result,
	snapshotCommand,
	type Command,
	type CommandContext,
	type CommandFailure,
	type DirectCommand,
	type Registration,
} from '@pluxel/commands'
import { isCommandResult } from '@pluxel/commands/internal'
import type { Context as CoreContext } from '@pluxel/core'
import { CALLER_CONTEXT_BIND, enterOwnerInvocation } from '@pluxel/core/internal'

/** A carrier endpoint pinned to its provider and publisher generations. */
export type MountedCommand<I, O, Ctx extends CommandContext = CommandContext> = Command<
	I,
	O,
	Ctx
> & {
	readonly mounted: true
}

type CommandInstaller<I, O, Ctx extends CommandContext> = (
	endpoint: MountedCommand<I, O, Ctx>,
) => Pick<Registration, 'name' | 'dispose'>

type CommandHandler<I, O, R, Source extends CommandContext, Ctx extends CommandContext> = (
	command: Command<I, O, Source>,
	candidate: unknown,
	context: Ctx,
) => Result<R, CommandFailure> | Promise<Result<R, CommandFailure>>

/** Provider-owned scope for generation-pinned carrier command publications. */
export interface CommandMount<Ctx extends CommandContext = CommandContext> {
	/**
	 * Run the entire carrier handler within both owner invocations. It constructs the command's
	 * trusted context, authorizes, executes, and settles presentation before releasing admission.
	 * Installation and withdrawal remain synchronous; disposal does not cancel admitted calls.
	 */
	bind<I, O, R, Source extends CommandContext>(
		command: DirectCommand<I, O, Source>,
		binding: {
			readonly handle: CommandHandler<I, O, R, Source, Ctx>
			readonly install: CommandInstaller<I, R, Ctx>
		},
	): Registration
	/** Publish the command directly when the carrier already supplies its required context. */
	bind<I, O>(
		command: DirectCommand<I, O, Ctx>,
		binding: { readonly install: CommandInstaller<I, O, Ctx> },
	): Registration
}

type BindingOptions<I, O, R, Source extends CommandContext, Ctx extends CommandContext> = {
	readonly handle?: CommandHandler<I, O, R, Source, Ctx>
	readonly install: CommandInstaller<I, R, Ctx>
}

type MountState = 'active' | 'withdrawn'
type BindingState = 'preparing' | 'active' | 'withdrawn'
type CleanupState = 'unavailable' | 'pending' | 'done'

type CleanupCell = {
	state: CleanupState
	dispose?: () => unknown
}

type BindingRecord = {
	readonly name: string
	state: BindingState
	withdrawal?: 'manual' | 'owner'
	readonly cleanup: CleanupCell
	guard?: { cancel(): void }
}

class CommandMountImpl<Ctx extends CommandContext> implements CommandMount<Ctx> {
	private state: MountState = 'active'
	private readonly bindings = new Set<BindingRecord>()
	private readonly views = new WeakMap<CoreContext, CommandMount<Ctx>>()

	constructor(private readonly providerOwner: CoreContext) {}

	start(): this {
		try {
			this.providerOwner.effects.defer(() => this.close(), { tag: 'CommandMount' })
		} catch (error) {
			this.state = 'withdrawn'
			throw error
		}
		return this
	}

	bind<I, O, R = O, Source extends CommandContext = Ctx>(
		command: DirectCommand<I, O, Source>,
		binding: BindingOptions<I, O, R, Source, Ctx>,
	): Registration {
		return this.bindFor(this.providerOwner, command, binding)
	}

	[CALLER_CONTEXT_BIND](publicationOwner: CoreContext): CommandMount<Ctx> {
		if (publicationOwner.root !== this.providerOwner.root) {
			throw new TypeError('[pluxel/runtime] Command mount cannot cross Runtime roots')
		}
		if (publicationOwner === this.providerOwner) return this
		const cached = this.views.get(publicationOwner)
		if (cached) return cached
		const view = Object.freeze(new CommandMountView(this, publicationOwner))
		this.views.set(publicationOwner, view)
		return view
	}

	bindFor<I, O, R, Source extends CommandContext>(
		publicationOwner: CoreContext,
		command: DirectCommand<I, O, Source>,
		binding: BindingOptions<I, O, R, Source, Ctx>,
	): Registration {
		this.assertBindingAdmission(publicationOwner)
		if (!binding || typeof binding !== 'object') {
			throw commandConfigError('Command mount binding must be an object', undefined, 'binding')
		}
		const { install, handle } = binding
		if (handle !== undefined && typeof handle !== 'function') {
			throw commandConfigError('Command mount handler must be a function', undefined, 'handler')
		}
		if (typeof install !== 'function') {
			throw commandConfigError('Command mount installer must be a function', undefined, 'installer')
		}
		const snapshot = snapshotDirectCommand(command)
		const record: BindingRecord = {
			name: snapshot.name,
			state: 'preparing',
			cleanup: { state: 'unavailable' },
		}
		const owned = this.ownedCommand(snapshot, record, publicationOwner, handle)

		let installerResult: unknown
		try {
			installerResult = install(owned)
		} catch (error) {
			record.state = 'withdrawn'
			throw error
		}

		let installerThen: Function | undefined
		try {
			installerThen = readThen(installerResult, snapshot.name)
		} catch (error) {
			record.state = 'withdrawn'
			this.disposeInstallerResult(
				installerResult,
				snapshot.name,
				'command mount installer rollback failed',
			)
			throw error
		}
		if (installerThen) {
			record.state = 'withdrawn'
			this.disposeInstallerResult(
				installerResult,
				snapshot.name,
				'command mount thenable rollback failed',
			)
			this.disposeLateInstallerResult(
				installerResult as object | Function,
				installerThen,
				snapshot.name,
			)
			throw commandConfigError(
				`Command mount installer for "${snapshot.name}" must return synchronously`,
				snapshot.name,
				'async_installer',
			)
		}

		try {
			captureInstallerCleanup(record.cleanup, installerResult, snapshot.name)
			const registrationName = readRegistrationName(installerResult, snapshot.name)
			if (registrationName !== snapshot.name) {
				throw commandConfigError(
					`Command mount installer returned registration "${registrationName}" for "${snapshot.name}"`,
					snapshot.name,
					'registration_name_mismatch',
				)
			}
			this.assertBindingAdmission(publicationOwner)
		} catch (error) {
			record.state = 'withdrawn'
			this.cleanup(record.cleanup, snapshot.name)
			throw error
		}

		try {
			record.guard = publicationOwner.effects.defer(() => this.withdraw(record, false), {
				tag: `CommandMount:${snapshot.name}`,
			})
			this.bindings.add(record)
			if (this.state !== 'active') {
				throw new CommandError('ABORTED', 'Command mount unavailable')
			}
			record.state = 'active'
		} catch (error) {
			record.state = 'withdrawn'
			this.bindings.delete(record)
			this.cancelGuard(record)
			this.cleanup(record.cleanup, snapshot.name)
			throw error
		}

		return Object.freeze({
			name: snapshot.name,
			dispose: () => this.withdraw(record, true),
			[Symbol.dispose]: () => this.withdraw(record, true),
		})
	}

	private ownedCommand<I, O, R, Source extends CommandContext>(
		snapshot: Command<I, O, Source>,
		record: BindingRecord,
		publicationOwner: CoreContext,
		handle?: CommandHandler<I, O, R, Source, Ctx>,
	): MountedCommand<I, R, Ctx> {
		return Object.freeze({
			mounted: true as const,
			name: snapshot.name,
			descriptor: snapshot.descriptor,
			execute: async (candidate: I, context?: Ctx): Promise<Result<R, CommandFailure>> => {
				if (this.state !== 'active' || record.withdrawal === 'owner') {
					return Result.err({ code: 'ABORTED', message: 'Command owner stopped' })
				}
				if (record.state !== 'active') {
					return Result.err({ code: 'COMMAND_NOT_FOUND', message: 'Command not found' })
				}

				let callSignal: AbortSignal | undefined
				try {
					callSignal = context?.signal
				} catch (error) {
					return Result.err({ code: 'INTERNAL', message: 'Invalid command context', cause: error })
				}
				if (callSignal !== undefined && !(callSignal instanceof AbortSignal)) {
					return Result.err({
						code: 'INTERNAL',
						message: 'Invalid command context',
						cause: new TypeError('Command context signal must be an AbortSignal'),
					})
				}

				let providerLease
				try {
					providerLease = enterOwnerInvocation(this.providerOwner, callSignal)
				} catch (error) {
					return Result.err(cancellationFailure(error))
				}

				let publicationLease
				try {
					if (publicationOwner !== this.providerOwner) {
						publicationLease = enterOwnerInvocation(publicationOwner, providerLease.signal)
					}
					const signal = publicationLease?.signal ?? providerLease.signal
					const commandContext = { ...(context ?? ({} as Ctx)), signal } as Ctx
					// Direct bindings require a compatible context and unchanged output at the public overload.
					const result: unknown = handle
						? await handle(snapshot, candidate, commandContext)
						: await Reflect.apply(snapshot.execute, snapshot, [candidate, commandContext])
					return isCommandResult(result)
						? (result as Result<R, CommandFailure>)
						: Result.err({
								code: 'INTERNAL',
								message: 'Command handler returned an invalid Result',
								cause: result,
							})
				} catch (error) {
					if (!publicationLease && publicationOwner !== this.providerOwner) {
						return Result.err(cancellationFailure(error))
					}
					const signal = publicationLease?.signal ?? providerLease.signal
					if (signal.aborted && error === signal.reason)
						return Result.err(cancellationFailure(error))
					return Result.err({ code: 'INTERNAL', message: 'Command execution failed', cause: error })
				} finally {
					publicationLease?.dispose()
					providerLease.dispose()
				}
			},
		}) as MountedCommand<I, R, Ctx>
	}

	private assertBindingAdmission(publicationOwner: CoreContext): void {
		if (this.state !== 'active') {
			throw new CommandError('ABORTED', 'Command mount unavailable')
		}
		if (publicationOwner.root !== this.providerOwner.root) {
			throw new TypeError('[pluxel/runtime] Command mount cannot cross Runtime roots')
		}

		let providerLease
		try {
			providerLease = enterOwnerInvocation(this.providerOwner)
			if (publicationOwner !== this.providerOwner) {
				const publicationLease = enterOwnerInvocation(publicationOwner, providerLease.signal)
				publicationLease.dispose()
			}
		} catch (error) {
			throw cancellationError(error)
		} finally {
			providerLease?.dispose()
		}
	}

	private withdraw(record: BindingRecord, cancelGuard: boolean): void {
		if (record.state === 'withdrawn') return
		record.withdrawal = cancelGuard ? 'manual' : 'owner'
		record.state = 'withdrawn'
		this.bindings.delete(record)
		if (cancelGuard) this.cancelGuard(record)
		this.cleanup(record.cleanup, record.name)
	}

	private close(): void {
		if (this.state === 'withdrawn') return
		this.state = 'withdrawn'
		const records = [...this.bindings]
		this.bindings.clear()
		for (const record of records) record.state = 'withdrawn'

		for (const record of records) {
			this.cancelGuard(record)
			this.cleanup(record.cleanup, record.name)
		}
	}

	private cancelGuard(record: BindingRecord): void {
		try {
			record.guard?.cancel()
		} catch (error) {
			this.reportCleanupFailure(
				'command mount effect guard cancellation failed',
				error,
				record.name,
			)
		}
	}

	private cleanup(cell: CleanupCell, command: string): void {
		if (cell.state !== 'pending') return
		cell.state = 'done'
		const dispose = cell.dispose
		cell.dispose = undefined
		try {
			const result = dispose?.()
			const then = readThen(result, command)
			if (then && result && (typeof result === 'object' || typeof result === 'function')) {
				this.consumeCleanupThenable(result, then, command)
			}
		} catch (error) {
			this.reportCleanupFailure('command mount cleanup failed', error, command)
		}
	}

	private consumeCleanupThenable(result: object | Function, then: Function, command: string): void {
		let settled = false
		const resolve = () => {
			settled = true
		}
		const reject = (error: unknown) => {
			if (settled) return
			settled = true
			this.reportCleanupFailure('async command mount cleanup failed', error, command)
		}
		try {
			Reflect.apply(then, result, [resolve, reject])
		} catch (error) {
			reject(error)
		}
	}

	private disposeLateInstallerResult(
		result: object | Function,
		then: Function,
		command: string,
	): void {
		let settled = false
		const resolve = (registration: unknown) => {
			if (settled) return
			settled = true
			if (registration === result) return
			try {
				const cleanup: CleanupCell = { state: 'unavailable' }
				captureInstallerCleanup(cleanup, registration, command)
				this.cleanup(cleanup, command)
			} catch (error) {
				this.reportCleanupFailure('late command mount installer cleanup failed', error, command)
			}
		}
		const reject = (error: unknown) => {
			if (settled) return
			settled = true
			this.reportCleanupFailure('late command mount installer rejected', error, command)
		}
		try {
			Reflect.apply(then, result, [resolve, reject])
		} catch (error) {
			reject(error)
		}
	}

	private disposeInstallerResult(result: unknown, command: string, message: string): void {
		if (!result || (typeof result !== 'object' && typeof result !== 'function')) return
		const cleanup: CleanupCell = { state: 'unavailable' }
		let dispose: unknown
		try {
			dispose = Reflect.get(result, 'dispose')
		} catch (error) {
			this.reportCleanupFailure(message, error, command)
			return
		}
		if (typeof dispose !== 'function') return
		cleanup.dispose = () => Reflect.apply(dispose, result, [])
		cleanup.state = 'pending'
		this.cleanup(cleanup, command)
	}

	private reportCleanupFailure(message: string, error: unknown, command: string): void {
		try {
			this.providerOwner.logger.error(message, { error, command })
		} catch {
			// Cleanup remains no-throw even if a diagnostics sink itself is broken.
		}
	}
}

class CommandMountView<Ctx extends CommandContext> implements CommandMount<Ctx> {
	constructor(
		private readonly mount: CommandMountImpl<Ctx>,
		private readonly publicationOwner: CoreContext,
	) {}

	bind<I, O, R = O, Source extends CommandContext = Ctx>(
		command: DirectCommand<I, O, Source>,
		binding: BindingOptions<I, O, R, Source, Ctx>,
	): Registration {
		return this.mount.bindFor(this.publicationOwner, command, binding)
	}
}

function snapshotDirectCommand<I, O, Ctx extends CommandContext>(
	command: DirectCommand<I, O, Ctx>,
): Command<I, O, Ctx> {
	if (!command || (typeof command !== 'object' && typeof command !== 'function')) {
		throw commandConfigError('Mounted command must be an object', undefined, 'invalid_command')
	}
	let isPublication: boolean
	try {
		isPublication = Reflect.has(command, 'dispose') || Reflect.has(command, 'mounted')
		if (isPublication) Reflect.get(command, 'dispose')
	} catch (error) {
		throw commandConfigError(
			'Mounted command has an unreadable registration disposer',
			undefined,
			'invalid_command',
			error,
		)
	}
	if (isPublication) {
		throw commandConfigError(
			'Command mount requires an unpublished command without dispose or mounted',
			undefined,
			'installed_command',
		)
	}

	return snapshotCommand(command)
}

function captureInstallerCleanup(cell: CleanupCell, registration: unknown, command: string): void {
	if (!registration || (typeof registration !== 'object' && typeof registration !== 'function')) {
		throw commandConfigError(
			`Command mount installer for "${command}" must return a registration`,
			command,
			'invalid_registration',
		)
	}
	let dispose: unknown
	try {
		dispose = Reflect.get(registration, 'dispose')
	} catch (error) {
		throw commandConfigError(
			`Command mount registration for "${command}" has an unreadable disposer`,
			command,
			'invalid_registration',
			error,
		)
	}
	if (typeof dispose !== 'function') {
		throw commandConfigError(
			`Command mount registration for "${command}" must define dispose`,
			command,
			'invalid_registration',
		)
	}
	cell.dispose = () => Reflect.apply(dispose, registration, [])
	cell.state = 'pending'
}

function readRegistrationName(registration: unknown, command: string): string {
	let name: unknown
	try {
		name = Reflect.get(registration as object, 'name')
	} catch (error) {
		throw commandConfigError(
			`Command mount registration for "${command}" has an unreadable name`,
			command,
			'invalid_registration',
			error,
		)
	}
	if (typeof name !== 'string') {
		throw commandConfigError(
			`Command mount registration for "${command}" must define name`,
			command,
			'invalid_registration',
		)
	}
	return name
}

function commandConfigError(
	message: string,
	command?: string,
	reason?: string,
	cause?: unknown,
): CommandError<'COMMAND_CONFIG'> {
	return new CommandError('COMMAND_CONFIG', 'Invalid command configuration', {
		message,
		details: {
			...(command ? { command } : {}),
			...(reason ? { reason } : {}),
		},
		...(cause !== undefined ? { cause } : {}),
	})
}

function readThen(value: unknown, command: string): Function | undefined {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
	let then: unknown
	try {
		then = Reflect.get(value, 'then')
	} catch (error) {
		throw commandConfigError(
			`Command mount installer for "${command}" returned an unreadable thenable`,
			command,
			'invalid_registration',
			error,
		)
	}
	return typeof then === 'function' ? then : undefined
}

function cancellationError(error: unknown): CommandError {
	return error instanceof CommandError && error.code === 'ABORTED'
		? error
		: new CommandError('ABORTED', 'Command cancelled', { cause: error })
}

function cancellationFailure(error: unknown): CommandFailure {
	return { code: 'ABORTED', message: 'Command cancelled', cause: error }
}

export function createCommandMount<Ctx extends CommandContext = CommandContext>(
	providerOwner: CoreContext,
): CommandMount<Ctx> {
	return new CommandMountImpl<Ctx>(providerOwner).start()
}
