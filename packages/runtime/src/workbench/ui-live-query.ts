import { useSyncExternalStore } from 'react'
import type {
	WorkbenchLiveQueryPatch,
	WorkbenchLiveQueryResource,
	WorkbenchLiveQuerySnapshot,
} from './contracts'
import type { RuntimeTransportClient } from '../web/transport-client'
import type { SseClientWithNamespaces } from '../web/sse'

export type WorkbenchLiveQueryResult<Row> =
	| Readonly<{ state: 'loading'; rows: readonly Row[]; error: null; revision: number }>
	| Readonly<{ state: 'ready'; rows: readonly Row[]; error: null; revision: number }>
	| Readonly<{ state: 'stale'; rows: readonly Row[]; error: Error; revision: number }>
	| Readonly<{ state: 'error'; rows: readonly Row[]; error: Error; revision: number }>

type LiveQueryArgs<Params> = [Params] extends [undefined] ? [] | [undefined] : [Params]
type LiveQuerySubscribeArgs<Params> = [Params] extends [undefined]
	? [listener: () => void]
	: [params: Params, listener: () => void]

export interface WorkbenchLiveQueryClient<Params, Row> {
	useQuery(...args: LiveQueryArgs<Params>): WorkbenchLiveQueryResult<Row>
	getSnapshot(...args: LiveQueryArgs<Params>): WorkbenchLiveQueryResult<Row>
	subscribe(...args: LiveQuerySubscribeArgs<Params>): () => void
	refresh(...args: LiveQueryArgs<Params>): Promise<void>
}

type BrowserLiveQueryState<Row> = WorkbenchLiveQueryResult<Row> & {
	generation?: string
}

class BrowserLiveQueryVariant<Row> {
	private state: BrowserLiveQueryState<Row> = Object.freeze({
		state: 'loading',
		rows: Object.freeze([]),
		error: null,
		revision: 0,
	})
	private readonly listeners = new Set<() => void>()
	private stream?: SseClientWithNamespaces
	private task: Promise<void> = Promise.resolve()

	constructor(
		private readonly transport: RuntimeTransportClient,
		private readonly grantId: string,
		private readonly params: unknown,
		private readonly contract: WorkbenchLiveQueryResource<any, Row>,
	) {}

	getSnapshot = (): WorkbenchLiveQueryResult<Row> => this.state

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		if (this.listeners.size === 1) this.start()
		return () => {
			this.listeners.delete(listener)
			if (this.listeners.size === 0) this.stop()
		}
	}

	async refresh(): Promise<void> {
		const response = await this.transport.fetch(
			this.transport.workbench.liveQueryUrl(this.grantId, this.params),
			{ method: 'GET' },
		)
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { message?: string }
			throw new Error(body.message ?? `liveQuery refresh failed: HTTP ${response.status}`)
		}
		await this.applySnapshot((await response.json()) as WorkbenchLiveQuerySnapshot<Row>)
	}

	private start(): void {
		const params = new URLSearchParams()
		if (this.params !== undefined) params.set('params', JSON.stringify(this.params))
		const base = this.transport.workbench.modelEventsUrl(this.grantId)
		const url = params.size > 0 ? `${base}?${params}` : base
		this.stream = this.transport.createSse({ url })
		this.stream.onAny((message) => {
			this.task = this.task
				.then(async () => {
					switch (message.event) {
						case 'snapshot':
							return await this.applySnapshot(message.payload as WorkbenchLiveQuerySnapshot<Row>)
						case 'patch':
							return await this.applyPatch(message.payload as WorkbenchLiveQueryPatch<Row>)
						case 'error':
							this.fail(new Error(String((message.payload as any)?.message ?? 'liveQuery failed')))
							return
					}
					return undefined
				})
				.catch((error) => this.fail(error))
		})
		this.stream.onError(() => this.fail(new Error('liveQuery stream disconnected')))
	}

	private stop(): void {
		this.stream?.close()
		this.stream = undefined
	}

	private async applySnapshot(snapshot: WorkbenchLiveQuerySnapshot<Row>): Promise<void> {
		if (
			!snapshot ||
			typeof snapshot.generation !== 'string' ||
			!Number.isInteger(snapshot.revision)
		) {
			throw new TypeError('invalid liveQuery snapshot')
		}
		const rows = await this.validateRows(snapshot.rows)
		this.update({
			state: 'ready',
			rows,
			error: null,
			revision: snapshot.revision,
			generation: snapshot.generation,
		})
	}

	private async applyPatch(patch: WorkbenchLiveQueryPatch<Row>): Promise<void> {
		if (
			!patch ||
			!this.state.generation ||
			patch.generation !== this.state.generation ||
			patch.fromRevision !== this.state.revision ||
			!Number.isInteger(patch.fromRevision) ||
			!Number.isInteger(patch.toRevision) ||
			patch.toRevision !== patch.fromRevision + 1
		) {
			await this.refresh()
			return
		}
		try {
			if (!Array.isArray(patch.removed) || !Array.isArray(patch.order)) {
				throw new TypeError('liveQuery patch keys must be arrays')
			}
			if (
				patch.removed.some((key) => !isLiveQueryKey(key)) ||
				patch.order.some((key) => !isLiveQueryKey(key)) ||
				new Set(patch.removed).size !== patch.removed.length ||
				new Set(patch.order).size !== patch.order.length
			) {
				throw new TypeError('liveQuery patch contains invalid or duplicate keys')
			}
			const upserted = await this.validateRows(patch.upserted)
			const byKey = new Map<string | number, Row>()
			for (const row of this.state.rows) byKey.set((row as any)[this.contract.key], row)
			for (const key of patch.removed) byKey.delete(key)
			for (const row of upserted) byKey.set((row as any)[this.contract.key], row)
			if (patch.order.length !== byKey.size) {
				throw new Error('liveQuery patch order does not describe the complete result')
			}
			const rows = patch.order.map((key) => {
				const row = byKey.get(key)
				if (!row) throw new Error(`liveQuery patch references missing key "${key}"`)
				return row
			})
			this.update({
				state: 'ready',
				rows: Object.freeze(rows),
				error: null,
				revision: patch.toRevision,
				generation: patch.generation,
			})
		} catch {
			await this.refresh()
		}
	}

	private async validateRows(rows: readonly Row[]): Promise<readonly Row[]> {
		if (!Array.isArray(rows)) throw new TypeError('liveQuery rows must be an array')
		const result: Row[] = []
		const keys = new Set<string | number>()
		for (const raw of rows) {
			const validation = await this.contract.row['~standard'].validate(raw)
			if (validation.issues) throw new TypeError('liveQuery row validation failed')
			const row = validation.value
			const key = (row as any)?.[this.contract.key]
			if (
				(typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key))) ||
				keys.has(key)
			) {
				throw new TypeError('liveQuery row key is invalid or duplicated')
			}
			keys.add(key)
			result.push(Object.freeze(row as Row))
		}
		return Object.freeze(result)
	}

	private fail(error: unknown): void {
		const cause = error instanceof Error ? error : new Error(String(error))
		this.update({
			...this.state,
			state: this.state.rows.length > 0 ? 'stale' : 'error',
			error: cause,
		})
	}

	private update(state: BrowserLiveQueryState<Row>): void {
		this.state = Object.freeze(state)
		for (const listener of this.listeners) listener()
	}
}

export function createLiveQueryClient<Params, Row>(
	transport: RuntimeTransportClient,
	grantId: string,
	contract: WorkbenchLiveQueryResource<Params, Row>,
): WorkbenchLiveQueryClient<Params, Row> {
	const variants = new Map<string, BrowserLiveQueryVariant<Row>>()
	const variant = (params: unknown) => {
		const key = stableLiveQueryParams(params)
		let current = variants.get(key)
		if (!current) {
			current = new BrowserLiveQueryVariant(transport, grantId, params, contract)
			variants.set(key, current)
		}
		return current
	}
	return Object.freeze({
		useQuery(...args: unknown[]) {
			const current = variant(args[0])
			return useSyncExternalStore(current.subscribe, current.getSnapshot, current.getSnapshot)
		},
		getSnapshot(...args: unknown[]) {
			return variant(args[0]).getSnapshot()
		},
		subscribe(...args: unknown[]) {
			const params = args.length === 1 ? undefined : args[0]
			const listener = args.at(-1) as () => void
			return variant(params).subscribe(listener)
		},
		refresh(...args: unknown[]) {
			return variant(args[0]).refresh()
		},
	}) as WorkbenchLiveQueryClient<Params, Row>
}

function isLiveQueryKey(value: unknown): value is string | number {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function stableLiveQueryParams(value: unknown): string {
	if (value === undefined) return 'undefined'
	if (Array.isArray(value)) return `[${value.map(stableLiveQueryParams).join(',')}]`
	if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableLiveQueryParams(child)}`)
		.join(',')}}`
}
