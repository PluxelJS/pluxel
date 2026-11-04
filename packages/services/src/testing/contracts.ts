import type { CommandContext, CommandDescriptor } from '@pluxel/commands'
import type { PluginTestTarget } from '@pluxel/core/internal/test'
import type { HostConfigMutation, HostOperationOptions, HostPluginConfigResult } from '@pluxel/host'

export interface ServiceConfigTestDriver<TTarget extends PluginTestTarget = PluginTestTarget> {
	/**
	 * Applies an atomic set/remove change through the production persistence and running-generation
	 * notification path. Fixture bootstrap config belongs on `host.start()` instead.
	 */
	patch(
		target: TTarget,
		patch: HostConfigMutation,
		options?: HostOperationOptions,
	): Promise<HostPluginConfigResult>
}

export interface ServiceHttpTestDriver {
	/** Logical in-process origin. It is not backed by a listening socket. */
	readonly origin: 'http://local.test'
	/** Dispatches through the production immutable Host HTTP directory. */
	fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>
}

export interface ServiceCommandsTestDriver {
	/** Executes the currently published command through the production command registry. */
	execute(name: string, input: unknown, context?: CommandContext): Promise<unknown>
	/** Returns the production registry's current immutable descriptor list. */
	list(): readonly CommandDescriptor[]
}
