import {
	BasePlugin,
	Plugin,
	formatPluginDefinitionReference,
	parsePluginNodeAddress,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import { Result } from '@pluxel/core/better-result'
import type {
	Inspection,
	InspectionFailure,
	InspectionPluginReport,
	InspectionPluginSection,
} from '@pluxel/host/agent'
import { createScriptScope, type ScriptInspectionBackend } from '@pluxel/host/agent/runtime'
import { createPluginControlReference } from '@pluxel/host/internal/control-reference'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { describe, expect, it, vi } from 'vitest'
import { createHost } from '../src/index'

@Plugin({ forkable: true })
class Inspectable extends BasePlugin {
	async hold(release: Promise<void>) {
		await release
	}
}

@Plugin()
class Before extends BasePlugin {}

type Report = Inspection<InspectionPluginReport<readonly InspectionPluginSection[]>>
const declaration = {
	file: '/execution/workspace/src/plugin.ts',
	start: { line: 3, column: 1 },
	end: { line: 6, column: 2 },
} as const

// Scope tests deliberately inject analysis results. Real compiler/source positions are
// exercised by the Rolldown and Vite integration suites, without duplicating their parser.
function report(definition: PluginDefinitionAddress): Report {
	return {
		root: '/execution/workspace',
		revision: 'observed-disk-revision',
		source: {
			content: 'current-disk',
			environment: 'query-process',
			runtimeMatch: 'unverified',
		},
		data: {
			summary: {
				definition,
				reference: formatPluginDefinitionReference(definition),
				exportName: definition.exportName,
				className: 'Inspectable',
				kind: 'plugin',
				declaration,
			},
			sections: {},
		},
	}
}

async function createInspectionHost() {
	const host = await createHost({
		plugins: [Inspectable],
		policy: { forks: [Inspectable.nodeAddress('east')] },
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	return host
}

describe('Plugin definition source inspection', () => {
	it('locates source, generated and discovered nodes through the same definition query', async () => {
		await using host = await createInspectionHost()
		const inspection = vi.fn<ScriptInspectionBackend>(async (definition) =>
			Result.ok(report(definition)),
		)
		const installation = { ctx: host.ctx, inspection: inspection as ScriptInspectionBackend }
		await using scope = createScriptScope(installation)
		installation.inspection = async () => {
			throw new Error('Caller mutation must not replace the scope source backend')
		}
		const descriptor = createPluginControlReference({
			format: 2,
			definition: Inspectable.definitionAddress(),
			contracts: { config: null, instance: `sha256:${'b'.repeat(64)}` },
		})
		const discovered = Result.unwrap(
			await scope.sdk.plugins.list({ definition: Inspectable.definitionAddress() }),
		)
		expect(discovered.nodes).toHaveLength(2)
		const addresses = [
			Inspectable.nodeAddress(),
			Inspectable.nodeAddress('east'),
			descriptor.nodeAddress(),
			descriptor.nodeAddress('east'),
			...discovered.nodes.map(({ address }) => address),
		]
		for (const address of addresses) {
			const { inspect } = scope.sdk
			const located = Result.unwrap(await inspect(address.definition))
			expect(located).toEqual({
				...report(Inspectable.definitionAddress()),
				source: {
					content: 'current-disk',
					environment: 'execution-target',
					runtimeMatch: 'unverified',
				},
			})
		}
		expect(inspection).toHaveBeenCalledTimes(addresses.length)
		for (const [definition, options] of inspection.mock.calls) {
			expect(definition).toEqual(Inspectable.definitionAddress())
			expect(options.include).toBeUndefined()
			expect(options.partPath).toBeUndefined()
			expect(options.signal).toBeInstanceOf(AbortSignal)
		}
		// Source lookup requires identity, never a generated instance contract or a running node.
		expect(await scope.sdk.plugin(descriptor.nodeAddress()).instance()).toMatchObject({
			status: 'error',
			error: { code: 'control_material_unavailable' },
		})
		expect(Result.unwrap(await scope.sdk.plugin(Inspectable.nodeAddress()).status())).toMatchObject(
			{
				lifecycleState: 'stopped',
			},
		)
	})

	it('retains partial sections, unavailable reasons and source diagnostics without filling gaps', async () => {
		await using host = await createInspectionHost()
		const definition = Inspectable.definitionAddress()
		const gap = {
			code: 'unresolved-part',
			message: 'Read the factory expression before modifying the Part',
			file: declaration.file,
			location: declaration,
		}
		const unavailable = {
			code: 'dynamic-application-input',
			message: 'Application input cannot be inspected statically',
			location: declaration,
		}
		const observed: Report = {
			...report(definition),
			data: {
				...report(definition).data,
				sections: {
					parts: { status: 'partial', value: { occurrences: [] }, gaps: [gap] },
					inputs: { status: 'unavailable', reason: unavailable },
				},
			},
		}
		const inspection = vi.fn<ScriptInspectionBackend>(async () => Result.ok(observed))
		await using scope = createScriptScope({ ctx: host.ctx, inspection })
		const include = ['parts', 'inputs'] as const
		const partPath = ['worker'] as const
		const located = Result.unwrap(
			await scope.sdk.inspect(Inspectable.definitionAddress(), {
				include,
				partPath,
			}),
		)
		expect(located.data.sections).toEqual(observed.data.sections)
		expect(inspection).toHaveBeenCalledWith(
			definition,
			expect.objectContaining({ include, partPath }),
		)
	})

	it('reports absent source backends without describing control materials as author source', async () => {
		await using host = await createInspectionHost()
		await using scope = createScriptScope({ ctx: host.ctx })
		expect(await scope.sdk.inspect(Inspectable.definitionAddress())).toMatchObject({
			status: 'error',
			error: {
				code: 'inspection_unavailable',
				reason: { code: 'inspection_backend_unavailable' },
			},
		})
	})

	it('rejects attempts to redirect a selected execution target to another application', async () => {
		await using host = await createInspectionHost()
		const inspection = vi.fn<ScriptInspectionBackend>(async (definition) =>
			Result.ok(report(definition)),
		)
		await using scope = createScriptScope({ ctx: host.ctx, inspection })
		const options = { include: ['inputs'], application: { root: '/another', entry: 'app.ts' } }
		expect(
			await scope.sdk.inspect(Inspectable.definitionAddress(), options as never),
		).toMatchObject({
			status: 'error',
			error: { code: 'invalid_input', context: {} },
		})
		expect(inspection).not.toHaveBeenCalled()
	})

	it('rejects malformed query options through promises instead of treating them as a default query', async () => {
		await using host = await createInspectionHost()
		const inspection = vi.fn<ScriptInspectionBackend>(async (definition) =>
			Result.ok(report(definition)),
		)
		await using scope = createScriptScope({ ctx: host.ctx, inspection })
		const malformed: readonly unknown[] = [42, null, []]
		for (const input of malformed) {
			const pending = scope.sdk.inspect(Inspectable.definitionAddress(), input as never)
			expect(pending).toBeInstanceOf(Promise)
			await expect(pending).rejects.toThrow(TypeError)
		}
		expect(inspection).not.toHaveBeenCalled()
		for (const target of [null, {}, Inspectable.nodeAddress()]) {
			const pending = scope.sdk.inspect(target as never)
			expect(pending).toBeInstanceOf(Promise)
			await expect(pending).rejects.toThrow(TypeError)
		}
		const valid = await scope.sdk.inspect(Inspectable.definitionAddress())
		expect(valid.isOk()).toBe(true)
		expect(inspection).toHaveBeenCalledOnce()
	})

	it('captures definition, option values and nested selection arrays when the query is called', async () => {
		await using host = await createInspectionHost()
		const inspection = vi.fn<ScriptInspectionBackend>(async (definition) =>
			Result.ok(report(definition)),
		)
		await using scope = createScriptScope({ ctx: host.ctx, inspection })
		const include: InspectionPluginSection[] = ['config']
		const partPath = ['worker']
		const originalSignal = new AbortController()
		const options = { include, partPath, signal: originalSignal.signal }
		const original = Inspectable.definitionAddress()
		const definition = { entry: { ...original.entry }, exportName: original.exportName }
		const pending = scope.sdk.inspect(definition, options)
		definition.exportName = 'Changed'
		if (definition.entry.kind === 'source-entry') definition.entry.path = 'changed.ts'
		include.push('dependencies')
		partPath[0] = 'changed-worker'
		options.include = ['inputs']
		options.partPath = ['another-worker']
		options.signal = new AbortController().signal
		Result.unwrap(await pending)
		expect(inspection).toHaveBeenCalledWith(
			Inspectable.definitionAddress(),
			expect.objectContaining({ include: ['config'], partPath: ['worker'] }),
		)
		originalSignal.abort(new Error('Original caller signal'))
		expect(inspection.mock.calls[0]![1].signal?.aborted).toBe(true)
	})

	it('locates definitions without contending with a borrowed business call', async () => {
		await using host = await createInspectionHost()
		const inspection = vi.fn<ScriptInspectionBackend>(async (definition) =>
			Result.ok(report(definition)),
		)
		await using scope = createScriptScope({ ctx: host.ctx, inspection })
		const selected = scope.sdk.plugin(Inspectable.nodeAddress())
		Result.unwrap(await selected.start())
		const instance = Result.unwrap(await selected.instance())
		const release = Promise.withResolvers<void>()
		const business = instance.hold(release.promise)
		try {
			const located = await scope.sdk.inspect(Inspectable.definitionAddress())
			expect(located.isOk()).toBe(true)
			expect(inspection).toHaveBeenCalledOnce()
		} finally {
			release.resolve()
			await business
		}
	})

	it('retains original compiler failure codes and context', async () => {
		await using host = await createInspectionHost()
		const failure: InspectionFailure = {
			code: 'analysis_unavailable',
			message: 'The source package contains no author TypeScript entry',
			context: { packageName: '@fixture/built-only', file: '/remote/node_modules/pkg/index.mjs' },
		}
		await using scope = createScriptScope({
			ctx: host.ctx,
			inspection: async () => Result.err(failure),
		})
		const result = await scope.sdk.inspect(Inspectable.definitionAddress())
		if (result.isOk()) throw new Error('Expected the original compiler failure')
		expect(result.error).toEqual(failure)
	})

	it('locates a definition after constructor replacement and catalog removal', async () => {
		const After = lowerTestReplacement(Before, class extends Before {})
		await using host = await createHost({
			plugins: [Before],
			runtime: { documents: { config: false, state: false } },
		})
		await host.start()
		const inspection = vi.fn<ScriptInspectionBackend>(async (definition) =>
			Result.ok(report(definition)),
		)
		await using scope = createScriptScope({ ctx: host.ctx, inspection })
		const selected = scope.sdk.plugin(Before.nodeAddress())
		await host.updateCatalog([After])
		expect(await selected.status()).toMatchObject({
			status: 'error',
			error: { code: 'stale_target' },
		})
		const current = Result.unwrap(await scope.sdk.inspect(After.definitionAddress()))
		const previous = Result.unwrap(await scope.sdk.inspect(Before.definitionAddress()))
		expect(current.data.summary.definition).toEqual(Before.definitionAddress())
		expect(previous).toEqual(current)
		expect(current.source.runtimeMatch).toBe('unverified')
		await host.updateCatalog([])
		const removed = await scope.sdk.inspect(Before.definitionAddress())
		expect(removed.isOk()).toBe(true)
		expect(inspection).toHaveBeenCalledTimes(3)
	})

	it.each(['diagnostic', 'throw'] as const)(
		'combines query cancellation with the run signal when the backend returns %s',
		async (mode) => {
			await using host = await createInspectionHost()
			const entered = Promise.withResolvers<AbortSignal>()
			const stopped = Promise.withResolvers<void>()
			const inspection: ScriptInspectionBackend = async (_definition, { signal }) => {
				if (!signal) throw new Error('Expected query signal')
				entered.resolve(signal)
				if (!signal.aborted)
					signal.addEventListener('abort', () => stopped.resolve(), { once: true })
				else stopped.resolve()
				await stopped.promise
				if (mode === 'throw') signal.throwIfAborted()
				return Result.err({ code: 'aborted', message: 'Compiler query cancelled', context: {} })
			}
			await using scope = createScriptScope({ ctx: host.ctx, inspection })
			const controller = new AbortController()
			const selected = scope.sdk.plugin(parsePluginNodeAddress(Inspectable.nodeAddress()))
			const pending = scope.sdk.inspect(Inspectable.definitionAddress(), {
				signal: controller.signal,
			})
			const querySignal = await entered.promise
			controller.abort(new Error('Stop this query'))
			expect(querySignal.aborted).toBe(true)
			expect(await pending).toMatchObject({ status: 'error', error: { code: 'cancelled' } })
			// Cancelling a query does not close this run or its borrowed Host.
			const status = await selected.status()
			expect(status.isOk()).toBe(true)
		},
	)

	it('drains an unawaited query and its backend cleanup before closing the run', async () => {
		await using host = await createInspectionHost()
		const entered = Promise.withResolvers<AbortSignal>()
		const release = Promise.withResolvers<void>()
		let backendClosed = false
		const inspection = vi.fn<ScriptInspectionBackend>(async (_definition, { signal }) => {
			if (!signal) throw new Error('Expected query signal')
			entered.resolve(signal)
			try {
				await release.promise
				signal.throwIfAborted()
				throw new Error('Expected closing scope to cancel the query')
			} finally {
				backendClosed = true
			}
		})
		const scope = createScriptScope({ ctx: host.ctx, inspection })
		const selected = scope.sdk.plugin(parsePluginNodeAddress(Inspectable.nodeAddress()))
		const { inspect } = scope.sdk
		const pending = inspect(Inspectable.definitionAddress())
		try {
			const querySignal = await entered.promise
			const closing = scope.dispose()
			expect(scope.dispose()).toBe(closing)
			expect(querySignal.aborted).toBe(true)
			let closed = false
			void closing.then((): undefined => {
				closed = true
				return undefined
			})
			await Promise.resolve()
			expect(closed).toBe(false)
			expect(backendClosed).toBe(false)
			release.resolve()
			await closing
			expect(backendClosed).toBe(true)
			expect(await pending).toMatchObject({ status: 'error', error: { code: 'cancelled' } })
			expect(await inspect(Inspectable.definitionAddress())).toMatchObject({
				status: 'error',
				error: { code: 'scope_closed' },
			})
			expect(inspection).toHaveBeenCalledOnce()
			expect(() => scope.sdk.plugin(selected.address)).toThrow('closing or closed')
		} finally {
			release.resolve()
			await scope.dispose()
		}
		await using nextRun = createScriptScope({ ctx: host.ctx })
		const status = await nextRun.sdk.plugin(selected.address).status()
		expect(status.isOk()).toBe(true)
	})

	it.each([false, true])(
		'leaves unknown backend defects rejected when the run is cancelled=%s',
		async (cancel) => {
			await using host = await createInspectionHost()
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			const failure = new Error('Unexpected analyzer invariant failure')
			await using scope = createScriptScope({
				ctx: host.ctx,
				inspection: async () => {
					entered.resolve()
					await release.promise
					throw failure
				},
			})
			const pending = scope.sdk.inspect(Inspectable.definitionAddress())
			await entered.promise
			if (cancel) scope.abort(new Error('Run cancelled independently'))
			release.resolve()
			await expect(pending).rejects.toBe(failure)
		},
	)
})
