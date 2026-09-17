import {
	CommandError,
	createCommandRegistry,
	type CommandContext,
	type CommandDescriptor,
	type CommandRegistration,
	type DirectCommand,
	type Registration,
} from '@pluxel/commands'
import type { Context as CoreContext } from '@pluxel/core'
import { CALLER_CONTEXT_BIND, enterOwnerInvocation } from '@pluxel/core/internal'

/** Provider-owned scope for generation-pinned carrier command publications. */
export interface CommandMount<Ctx extends CommandContext = CommandContext> {
	/**
	 * Publish one direct command through a synchronous carrier installer.
	 *
	 * The installer receives a wrapper pinned to the provider and publication-owner generations.
	 * The returned registration withdraws future carrier lookup without cancelling admitted calls.
	 */
	bind<I, O>(
		command: DirectCommand<I, O, Ctx>,
		install: (owned: DirectCommand<I, O, Ctx>) => Registration,
	): Registration
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
	readonly cleanup: CleanupCell
	guard?: { cancel(): void }
}

type CommandSnapshot<I, O, Ctx extends CommandContext> = {
	readonly name: string
	readonly descriptor: CommandDescriptor
	readonly receiver: DirectCommand<I, O, Ctx>
	readonly execute: DirectCommand<I, O, Ctx>['execute']
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

	bind<I, O>(
		command: DirectCommand<I, O, Ctx>,
		install: (owned: DirectCommand<I, O, Ctx>) => Registration,
	): Registration {
		return this.bindFor(this.providerOwner, command, install)
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

	bindFor<I, O>(
		publicationOwner: CoreContext,
		command: DirectCommand<I, O, Ctx>,
		install: (owned: DirectCommand<I, O, Ctx>) => Registration,
	): Registration {
		this.assertBindingAdmission(publicationOwner)
		if (typeof install !== 'function') {
			throw commandConfigError('Command mount installer must be a function', undefined, 'installer')
		}
		const snapshot = snapshotDirectCommand(command)
		const record: BindingRecord = {
			name: snapshot.name,
			state: 'preparing',
			cleanup: { state: 'unavailable' },
		}
		const owned = this.ownedCommand(snapshot, record, publicationOwner)

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
		})
	}

	private ownedCommand<I, O>(
		snapshot: CommandSnapshot<I, O, Ctx>,
		record: BindingRecord,
		publicationOwner: CoreContext,
	): DirectCommand<I, O, Ctx> {
		return Object.freeze({
			name: snapshot.name,
			descriptor: snapshot.descriptor,
			execute: async (candidate: unknown, context?: Ctx): Promise<O> => {
				if (this.state !== 'active' || record.state !== 'active') {
					throw commandNotFound(snapshot.name)
				}

				let providerLease
				try {
					providerLease = enterOwnerInvocation(this.providerOwner, context?.signal)
				} catch (error) {
					throw cancellationError(error)
				}

				let publicationLease
				try {
					if (publicationOwner !== this.providerOwner) {
						publicationLease = enterOwnerInvocation(publicationOwner, providerLease.signal)
					}
					const signal = publicationLease?.signal ?? providerLease.signal
					const commandContext = { ...(context ?? ({} as Ctx)), signal } as Ctx
					return (await Reflect.apply(snapshot.execute, snapshot.receiver, [
						candidate,
						commandContext,
					])) as O
				} catch (error) {
					if (!publicationLease && publicationOwner !== this.providerOwner) {
						throw cancellationError(error)
					}
					throw error
				} finally {
					publicationLease?.dispose()
					providerLease.dispose()
				}
			},
		}) as DirectCommand<I, O, Ctx>
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

	bind<I, O>(
		command: DirectCommand<I, O, Ctx>,
		install: (owned: DirectCommand<I, O, Ctx>) => Registration,
	): Registration {
		return this.mount.bindFor(this.publicationOwner, command, install)
	}
}

function snapshotDirectCommand<I, O, Ctx extends CommandContext>(
	command: DirectCommand<I, O, Ctx>,
): CommandSnapshot<I, O, Ctx> {
	if (!command || (typeof command !== 'object' && typeof command !== 'function')) {
		throw commandConfigError('Mounted command must be an object', undefined, 'invalid_command')
	}
	let hasDisposer: boolean
	try {
		hasDisposer = Reflect.has(command, 'dispose')
		if (hasDisposer) Reflect.get(command, 'dispose')
	} catch (error) {
		throw commandConfigError(
			'Mounted command has an unreadable registration disposer',
			undefined,
			'invalid_command',
			error,
		)
	}
	if (hasDisposer) {
		throw commandConfigError(
			'Mounted command must be a lifecycle-neutral direct implementation without dispose',
			undefined,
			'installed_command',
		)
	}

	let execute: unknown
	try {
		execute = Reflect.get(command, 'execute')
	} catch (error) {
		throw commandConfigError(
			'Mounted command execute must be readable',
			undefined,
			'invalid_command',
			error,
		)
	}
	if (typeof execute !== 'function') {
		throw commandConfigError('Mounted command must define execute', undefined, 'invalid_execute')
	}

	const validationRegistry = createCommandRegistry<Ctx>()
	let validation: CommandRegistration<I, O, Ctx>
	try {
		validation = validationRegistry.register(command)
	} catch (error) {
		throw error instanceof CommandError
			? error
			: commandConfigError(
					'Mounted command failed direct-command validation',
					undefined,
					'invalid_command',
					error,
				)
	}
	const name = validation.name
	const descriptor = validation.descriptor
	validation.dispose()
	if (typeof name !== 'string' || name.length === 0) {
		throw commandConfigError(
			'Mounted command must define a non-empty string name',
			undefined,
			'invalid_name',
		)
	}

	return {
		name,
		descriptor,
		receiver: command,
		execute: execute as DirectCommand<I, O, Ctx>['execute'],
	}
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

function commandNotFound(name: string): CommandError<'COMMAND_NOT_FOUND'> {
	return new CommandError('COMMAND_NOT_FOUND', 'Command not found', {
		message: `Command "${name}" is no longer mounted`,
		details: { name },
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

export function createCommandMount<Ctx extends CommandContext = CommandContext>(
	providerOwner: CoreContext,
): CommandMount<Ctx> {
	return new CommandMountImpl<Ctx>(providerOwner).start()
}
