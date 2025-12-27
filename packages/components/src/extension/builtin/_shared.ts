import { useEffect, useMemo, useState } from 'react'
import type { BuiltinSseRef, ExtensionContext } from '../types'

export function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object'
}

export function getByDotPath(obj: unknown, path: string | undefined): unknown {
	if (!path) return obj
	const trimmed = path.trim()
	if (!trimmed) return obj
	let cur: any = obj
	for (const segment of trimmed.split('.')) {
		if (!segment) continue
		if (!isObject(cur)) return undefined
		cur = (cur as any)[segment]
	}
	return cur
}

export function useSseEventState(ctx: ExtensionContext, namespace: string, events: string[]) {
	const [state, setState] = useState<Record<string, unknown>>({})

	const client = (ctx.services as any)?.hmr?.sse ?? (ctx.services as any)?.sse
	const key = `${namespace}::${events.slice().sort().join(',')}`

	useEffect(() => {
		if (!client || typeof client.ns !== 'function') return
		if (!namespace) return
		if (!events.length) return

		let disposed = false
		const disposers: Array<() => void> = []
		const nsClient = client.ns(namespace)

		for (const ev of events) {
			disposers.push(
				nsClient.on((msg: any) => {
					if (disposed) return
					setState((prev) => ({ ...prev, [ev]: msg?.payload }))
				}, ev),
			)
		}

		return () => {
			disposed = true
			for (const d of disposers) d()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, client])

	return state
}

export function resolveSseRef(ref: BuiltinSseRef, sseStateByEvent: Record<string, unknown>) {
	const ev =
		typeof (ref as any).event === 'string' && (ref as any).event ? (ref as any).event : 'state'
	const payload = sseStateByEvent[ev]
	const picked = getByDotPath(
		payload,
		typeof (ref as any).path === 'string' ? (ref as any).path : undefined,
	)
	return picked === undefined ? (ref as any).fallback : picked
}

export function neededSseEventsForValue(value: unknown): string[] {
	const events = new Set<string>()
	const visit = (v: any) => {
		if (!isObject(v)) return
		if (v.kind === 'sse') {
			events.add(typeof v.event === 'string' && v.event ? v.event : 'state')
			return
		}
	}
	visit(value)
	return Array.from(events)
}

export function useSseForValues(ctx: ExtensionContext, namespace: string, values: unknown[]) {
	const neededEvents = useMemo(() => {
		const events = new Set<string>()
		for (const v of values) {
			for (const ev of neededSseEventsForValue(v)) events.add(ev)
		}
		return Array.from(events)
	}, [values])

	return useSseEventState(ctx, namespace, neededEvents)
}
