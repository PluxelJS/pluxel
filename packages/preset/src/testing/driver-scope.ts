import { Commands } from '@pluxel/services/commands'
import { type PluginNodeAddress, type RootContext } from '@pluxel/core'
import { PluginTestOperationGate } from '@pluxel/core/internal/test'
import { type PluginTestTarget } from '@pluxel/core/test'
import { pluginConfigPatch } from '@pluxel/host/internal'
import { resolveContextCapability } from '@pluxel/core/host'
import {
	type ServiceCommandsTestDriver,
	type ServiceConfigTestDriver,
	type ServiceHttpTestDriver,
} from './contracts'

const TEST_HTTP_ORIGIN = 'http://local.test' as const

export type ServiceTestDriverScopeOptions<TTarget extends PluginTestTarget> = Readonly<{
	ctx: RootContext
	/** Resolve and validate a target against the owning host's current catalog. */
	resolveTarget(target: TTarget): PluginNodeAddress
}>

/**
 * Shared in-process service drivers and their child-resource boundary.
 *
 * Service test hosts compose this scope instead of duplicating driver
 * normalization, mutation exclusion, or response-body cleanup.
 */
export interface ServiceTestDriverScope<TTarget extends PluginTestTarget> extends AsyncDisposable {
	readonly config: ServiceConfigTestDriver<TTarget>
	readonly http: ServiceHttpTestDriver
	readonly commands: ServiceCommandsTestDriver
	runMutation<T>(operation: string, run: () => Promise<T> | T): Promise<T>
	assertQuery(operation: string): void
	dispose(beforeCleanup?: () => void | Promise<void>): Promise<void>
}

type TrackedBody = Readonly<{
	cancel(): Promise<void>
}>

export function createServiceTestDriverScope<TTarget extends PluginTestTarget>(
	options: ServiceTestDriverScopeOptions<TTarget>,
): ServiceTestDriverScope<TTarget> {
	const { ctx, resolveTarget } = options
	const gate = new PluginTestOperationGate()
	const bodies = new Set<TrackedBody>()

	const config: ServiceConfigTestDriver<TTarget> = Object.freeze({
		patch: (target: TTarget, patch: Readonly<Record<string, unknown>>) =>
			gate.runMutation('config.patch', () => pluginConfigPatch(ctx, resolveTarget(target), patch)),
	})

	const fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
		gate.assertAccepting('http.fetch')
		const request = normalizeRequest(input, init)
		const { HttpServer } = await import('@pluxel/services/http')
		gate.assertAccepting('http.fetch')
		const response = await resolveContextCapability(ctx, HttpServer).fetch(request)
		try {
			gate.assertAccepting('http.fetch result')
		} catch (error) {
			void response.body?.cancel(error).catch((): undefined => undefined)
			throw error
		}
		return trackResponseBody(response, bodies)
	}
	const http: ServiceHttpTestDriver = Object.freeze({ origin: TEST_HTTP_ORIGIN, fetch })

	const commands: ServiceCommandsTestDriver = Object.freeze({
		execute(name: string, input: unknown, context?: import('@pluxel/commands').CommandContext) {
			gate.assertAccepting('commands.execute')
			return ctx.require(Commands).execute(name, input, context)
		},
		list() {
			gate.assertAccepting('commands.list')
			return ctx.require(Commands).list()
		},
	})

	let scope!: ServiceTestDriverScope<TTarget>
	const dispose = (beforeCleanup?: () => void | Promise<void>) =>
		gate.dispose(async () => {
			const errors: unknown[] = []
			try {
				await beforeCleanup?.()
			} catch (error) {
				errors.push(error)
			}
			for (const body of bodies) {
				try {
					await body.cancel()
				} catch (error) {
					errors.push(error)
				}
			}
			throwCollected(errors, 'Service test driver cleanup failed')
		})

	scope = Object.freeze({
		config,
		http,
		commands,
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
			finish()
			// A Fetch implementation may leave cancellation pending while an upstream
			// stream is never pulled. Host teardown still signals cancellation, but it
			// must not turn that non-cooperative stream into an unbounded test hang.
			void reader
				.cancel(new Error('[pluxel/test] Service test host disposed'))
				.catch((): undefined => undefined)
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

function throwCollected(errors: readonly unknown[], message: string): void {
	if (errors.length === 0) return
	if (errors.length === 1) throw errors[0]
	throw new AggregateError(errors, message)
}
