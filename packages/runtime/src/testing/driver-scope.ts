import type { PluginNodeAddress, RootContext } from '@pluxel/core'
import { PluginTestOperationGate } from '@pluxel/core/internal/test'
import type { PluginTestTarget } from '@pluxel/core/test'
import { RpcStub } from 'capnweb'
import { pluginConfigPatch } from '../api/usecases/pluginConfig'
import { requireRuntimeHttpService } from '../context/runtime-http-capability'
import { requireWorkbench } from '../services/workbench'
import {
	openWorkbenchEntry,
	readWorkbenchLayout,
} from '../workbench/client'
import {
	readWorkbenchOpenedContentHandle,
	readWorkbenchOpenedViewHandle,
	type WorkbenchOpenedContentHandle,
	type WorkbenchOpenedViewHandle,
} from '../workbench/opened-entry'
import { readWorkbenchDescriptor } from '../workbench/definition'
import type {
	RuntimeCommandsTestDriver,
	RuntimeConfigTestDriver,
	RuntimeHttpTestDriver,
	RuntimeWorkbenchTestDriver,
	WorkbenchTestOpenOptions,
	WorkbenchTestOpenableEntry,
	OpenedWorkbenchTestEntry,
} from './contracts'

const TEST_HTTP_ORIGIN = 'http://local.test' as const

export type RuntimeTestDriverScopeOptions<TTarget extends PluginTestTarget> = Readonly<{
	ctx: RootContext
	/** Resolve and validate a target against the owning host's current catalog. */
	resolveTarget(target: TTarget): PluginNodeAddress
}>

/**
 * Shared in-process Runtime drivers and their child-resource boundary.
 *
 * Runtime and static application test hosts compose this scope instead of duplicating driver
 * normalization, mutation exclusion, Workbench ownership, or response-body cleanup.
 */
export interface RuntimeTestDriverScope<TTarget extends PluginTestTarget>
	extends AsyncDisposable {
	readonly config: RuntimeConfigTestDriver<TTarget>
	readonly http: RuntimeHttpTestDriver
	readonly commands: RuntimeCommandsTestDriver
	readonly workbench: RuntimeWorkbenchTestDriver<TTarget>
	runMutation<T>(operation: string, run: () => Promise<T> | T): Promise<T>
	assertQuery(operation: string): void
	dispose(): Promise<void>
}

type TrackedWorkbenchLease = Readonly<{
	target: PluginNodeAddress
	descriptor: string
	createdAt?: string
	isActive(): boolean
	dispose(): void
}>

type TrackedBody = Readonly<{
	cancel(): Promise<void>
}>

export function createRuntimeTestDriverScope<TTarget extends PluginTestTarget>(
	options: RuntimeTestDriverScopeOptions<TTarget>,
): RuntimeTestDriverScope<TTarget> {
	const { ctx, resolveTarget } = options
	const gate = new PluginTestOperationGate()
	const leases: TrackedWorkbenchLease[] = []
	const bodies = new Set<TrackedBody>()

	const config: RuntimeConfigTestDriver<TTarget> = Object.freeze({
		patch: (target: TTarget, patch: Readonly<Record<string, unknown>>) =>
			gate.runMutation('config.patch', () => pluginConfigPatch(ctx, resolveTarget(target), patch)),
	})

	const fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
		gate.assertAccepting('http.fetch')
		const request = normalizeRequest(input, init)
		const response = await requireRuntimeHttpService(ctx).fetch(request)
		gate.assertAccepting('http.fetch result')
		return trackResponseBody(response, bodies)
	}
	const http: RuntimeHttpTestDriver = Object.freeze({ origin: TEST_HTTP_ORIGIN, fetch })

	const commands: RuntimeCommandsTestDriver = Object.freeze({
		execute(name: string, input: unknown, context?: import('@pluxel/commands').CommandContext) {
			gate.assertAccepting('commands.execute')
			return ctx.commands.execute(name, input, context)
		},
		list() {
			gate.assertAccepting('commands.list')
			return ctx.commands.list()
		},
	})

	const workbench: RuntimeWorkbenchTestDriver<TTarget> = Object.freeze({
		async open<const Entry extends WorkbenchTestOpenableEntry>(
			openOptions: WorkbenchTestOpenOptions<Entry, TTarget>,
		): Promise<OpenedWorkbenchTestEntry<Entry>> {
			gate.assertAccepting('workbench.open')
			const target = resolveTarget(openOptions.target)
			const backend = requireWorkbench(ctx)
			const metadata = readWorkbenchDescriptor(openOptions.entry)
			if (!backend.registry.hasPublishedEntry(target, openOptions.entry)) {
				throw workbenchSetupError(
					target,
					metadata.key,
					'target_unavailable',
					'target is not running or did not publish this exact authored entry',
				)
			}

			const session = backend.createSession(openOptions.principal, () => undefined)
			const rpc = new RpcStub(session.target)
			let handle: WorkbenchOpenedViewHandle | WorkbenchOpenedContentHandle | undefined
			try {
				const layout = await readWorkbenchLayout(rpc, { target })
				const layoutEntry = layout.entries.find(
					(entry) =>
						entry.descriptor.kind === metadata.kind && entry.descriptor.key === metadata.key,
				)
				if (!layoutEntry) {
					throw workbenchSetupError(
						target,
						metadata.key,
						'target_unavailable',
						'entry is absent from the current target layout',
					)
				}
				const opened = await openWorkbenchEntry(rpc, layoutEntry, {
					layoutRevision: layout.revision,
					...(openOptions.location === undefined ? {} : { location: openOptions.location }),
				})
				if (opened.ok === false) {
					throw workbenchSetupError(
						target,
						metadata.key,
						opened.code,
						'production openEntry rejected the fixture',
					)
				}
				handle = opened.handle
				const value =
					handle.kind === 'content'
						? contentLeaseValue(handle)
						: viewLeaseValue(handle, metadata.kind)
				const tracked = createTrackedWorkbenchLease({
					target,
					descriptor: `${metadata.kind}:${metadata.key}`,
					handle,
					rpc,
					session,
					onDispose: (lease) => {
						const index = leases.indexOf(lease)
						if (index >= 0) leases.splice(index, 1)
					},
				})
				leases.push(tracked.lease)
				gate.assertAccepting('workbench.open result')
				return Object.freeze({ ...value, [Symbol.dispose]: tracked.dispose }) as never
			} catch (error) {
				try {
					handle?.[Symbol.dispose]()
				} finally {
					try {
						rpc[Symbol.dispose]()
					} finally {
						session.dispose()
					}
				}
				throw error
			}
		},
	})

	let scope!: RuntimeTestDriverScope<TTarget>
	const dispose = () =>
		gate.dispose(async () => {
			const errors: unknown[] = []
			for (const body of [...bodies]) {
				try {
					await body.cancel()
				} catch (error) {
					errors.push(error)
				}
			}
			for (const lease of [...leases].toReversed()) {
				if (!lease.isActive()) continue
				errors.push(
					new Error(
						`[pluxel/test] Leaked Workbench entry ${lease.descriptor} for ${JSON.stringify(lease.target)}${lease.createdAt ? `\nCreated at:${lease.createdAt}` : ''}`,
					),
				)
				try {
					lease.dispose()
				} catch (error) {
					errors.push(error)
				}
			}
			throwCollected(errors, 'Runtime test driver cleanup failed')
		})

	scope = Object.freeze({
		config,
		http,
		commands,
		workbench,
		runMutation: <T>(operation: string, run: () => Promise<T> | T) =>
			gate.runMutation(operation, run),
		assertQuery: (operation: string) => gate.assertReadable(operation),
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
	return scope
}

function normalizeRequest(input: Request | URL | string, init?: RequestInit): Request {
	if (input instanceof Request) return init === undefined ? input : new Request(input, init)
	let url: URL
	try {
		url = input instanceof URL ? new URL(input.href) : new URL(input)
	} catch (error) {
		throw new TypeError(
			'[pluxel/test] http.fetch string input must be an absolute URL; use new URL(path, host.http.origin)',
			{ cause: error },
		)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError('[pluxel/test] http.fetch only accepts HTTP(S) URLs')
	}
	return new Request(url, init)
}

function trackResponseBody(response: Response, bodies: Set<TrackedBody>): Response {
	if (!response.body) return response
	const reader = response.body.getReader()
	let tracked!: TrackedBody
	let active = true
	const finish = () => {
		if (!active) return
		active = false
		bodies.delete(tracked)
	}
	tracked = Object.freeze({
		async cancel(): Promise<void> {
			if (!active) return
			try {
				await reader.cancel(new Error('[pluxel/test] Runtime test host disposed'))
			} finally {
				finish()
			}
		},
	})
	bodies.add(tracked)
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await reader.read()
				if (chunk.done) {
					finish()
					controller.close()
				} else {
					controller.enqueue(chunk.value)
				}
			} catch (error) {
				finish()
				controller.error(error)
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason)
			} finally {
				finish()
			}
		},
	})
	const wrapped = new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
	for (const [key, value] of [
		['url', response.url],
		['redirected', response.redirected],
		['type', response.type],
	] as const) {
		try {
			Object.defineProperty(wrapped, key, { value })
		} catch {
			// These diagnostics are optional; Fetch payload semantics remain intact.
		}
	}
	return wrapped
}

function viewLeaseValue(handle: WorkbenchOpenedViewHandle, expectedKind: string) {
	const value = readWorkbenchOpenedViewHandle(handle)
	if (expectedKind === 'view' && value.kind === 'local') {
		return {
			kind: 'view' as const,
			api: value.api,
			params: value.params,
			federatedViewRef: value.federatedViewRef,
		}
	}
	if (expectedKind === 'attachment-placement' && value.kind === 'attachment') {
		return {
			kind: 'attachment' as const,
			provider: value.provider,
			consumer: value.consumer,
			params: value.params,
			federatedViewRef: value.federatedViewRef,
		}
	}
	throw new Error(
		`[pluxel/test] Workbench opened kind ${value.kind} does not match authored ${expectedKind}`,
	)
}

function contentLeaseValue(handle: WorkbenchOpenedContentHandle) {
	const value = readWorkbenchOpenedContentHandle(handle)
	return value.mode === 'static'
		? {
				kind: 'content' as const,
				mode: 'static' as const,
				params: value.params,
				contentRef: value.contentRef,
				plan: value.plan,
			}
		: {
				kind: 'content' as const,
				mode: 'interactive' as const,
				params: value.params,
				contentRef: value.contentRef,
				plan: value.plan,
				presentation: value.presentation,
				root: value.root,
			}
}

function createTrackedWorkbenchLease(input: {
	target: PluginNodeAddress
	descriptor: string
	handle: WorkbenchOpenedViewHandle | WorkbenchOpenedContentHandle
	rpc: RpcStub<import('../workbench/client-protocol').WorkbenchSessionApi>
	session: import('../services/workbench').WorkbenchServerSession
	onDispose(lease: TrackedWorkbenchLease): void
}): Readonly<{ lease: TrackedWorkbenchLease; dispose(): void }> {
	let active = true
	let lease!: TrackedWorkbenchLease
	const createdAt = new Error().stack?.split('\n').slice(2, 7).join('\n')
	const dispose = () => {
		if (!active) return
		active = false
		input.onDispose(lease)
		const errors: unknown[] = []
		for (const cleanup of [
			() => input.handle[Symbol.dispose](),
			() => input.rpc[Symbol.dispose](),
			() => input.session.dispose(),
		]) {
			try {
				cleanup()
			} catch (error) {
				errors.push(error)
			}
		}
		throwCollected(errors, 'Workbench test lease cleanup failed')
	}
	lease = Object.freeze({
		target: input.target,
		descriptor: input.descriptor,
		...(createdAt ? { createdAt } : {}),
		isActive: () => active,
		dispose,
	})
	return Object.freeze({ lease, dispose })
}

function workbenchSetupError(
	target: PluginNodeAddress,
	entry: string,
	code: string,
	detail: string,
): Error {
	return Object.assign(
		new Error(
			`[pluxel/test] workbench.open(${target.definition.exportName}.${entry}) failed (${code}): ${detail}`,
		),
		{ code },
	)
}

function throwCollected(errors: readonly unknown[], message: string): void {
	if (errors.length === 0) return
	if (errors.length === 1) throw errors[0]
	throw new AggregateError(errors, message)
}
