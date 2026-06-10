import type {
	BuiltinFieldValueRef,
	BuiltinGeneratedIdValue,
	BuiltinNowValue,
	BuiltinSignalDbRef,
	BuiltinSignalDbWriteSpec,
	BuiltinTemplateValue,
} from '@pluxel/runtime/web/extensions'
import { useMemo } from 'react'
import { useGlobalExtensionContext, useSignalDbCollectionsState } from '@pluxel/runtime/web'

export function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

export function stableSignalDbValueKey(value: unknown, seen = new WeakSet<object>()): string {
	if (value === null) return 'null'
	if (value === undefined) return 'undefined'
	const type = typeof value
	if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
		return `${type}:${String(value)}`
	}
	if (type === 'symbol') return `symbol:${String(value)}`
	if (type === 'function') return `function:${(value as Function).name || 'anonymous'}`
	if (value instanceof Date) return `date:${value.toISOString()}`
	if (type !== 'object') return type
	if (seen.has(value as object)) return '[Circular]'
	seen.add(value as object)
	if (Array.isArray(value)) {
		return `array:[${value.map((item) => stableSignalDbValueKey(item, seen)).join(',')}]`
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	)
	const key = `object:{${entries
		.map(([key, entryValue]) => `${key}:${stableSignalDbValueKey(entryValue, seen)}`)
		.join(',')}}`
	seen.delete(value as object)
	return key
}

export function resolveSignalDbRef(
	ref: BuiltinSignalDbRef,
	collections: Record<string, { findOne: (selector: Record<string, unknown>) => unknown }>,
) {
	const collection = collections[ref.collection]
	if (!collection) return (ref as any).fallback
	const doc = collection.findOne((ref.selector ?? {}) as Record<string, unknown>)
	const picked = getByDotPath(doc, typeof ref.path === 'string' ? ref.path : undefined)
	return picked === undefined ? (ref as any).fallback : picked
}

export function neededSignalDbCollectionsForValue(value: unknown): string[] {
	const collections = new Set<string>()
	const visit = (input: unknown): void => {
		if (Array.isArray(input)) {
			for (const item of input) visit(item)
			return
		}
		if (!input || typeof input !== 'object') return
		const obj = input as Record<string, unknown>
		if (obj.kind === 'signaldb' && typeof obj.collection === 'string' && obj.collection) {
			collections.add(obj.collection)
			return
		}
		for (const item of Object.values(obj)) visit(item)
	}
	visit(value)
	return Array.from(collections)
}

export function useSignalDbForValues(namespace: string, values: unknown[]) {
	const transport = useGlobalExtensionContext().services.transport
	const valuesKey = stableSignalDbValueKey(values)
	const neededCollections = useMemo(() => {
		const collections = new Set<string>()
		for (const value of values) {
			for (const collection of neededSignalDbCollectionsForValue(value)) collections.add(collection)
		}
		return Array.from(collections)
	}, [valuesKey])

	return useSignalDbCollectionsState(transport, namespace, neededCollections)
}

function createGeneratedId() {
	if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
	return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function resolveSpecialTemplateValue(
	value: BuiltinFieldValueRef | BuiltinGeneratedIdValue | BuiltinNowValue,
	scope: Record<string, unknown>,
) {
	switch (value.kind) {
		case 'field':
			return scope[value.key]
		case 'generatedId':
			return createGeneratedId()
		case 'now':
			return value.format === 'iso' ? new Date().toISOString() : Date.now()
		default:
			return undefined
	}
}

export function resolveTemplateValue(
	template: BuiltinTemplateValue | undefined,
	scope: Record<string, unknown>,
): unknown {
	if (template === undefined) return scope
	if (Array.isArray(template)) {
		return template.map((item) => resolveTemplateValue(item, scope))
	}
	if (!template || typeof template !== 'object') return template

	const kind = (template as { kind?: unknown }).kind
	if (kind === 'field' || kind === 'generatedId' || kind === 'now') {
		return resolveSpecialTemplateValue(template as any, scope)
	}

	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(template)) {
		out[key] = resolveTemplateValue(value as BuiltinTemplateValue, scope)
	}
	return out
}

function ensureWritableObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('signaldb write value must resolve to an object')
	}
	return { ...(value as Record<string, unknown>) }
}

function ensureDocId(value: Record<string, unknown>) {
	return typeof value.id === 'string' && value.id.trim()
		? value
		: { ...value, id: createGeneratedId() }
}

function normalizeWriteMode(write: BuiltinSignalDbWriteSpec) {
	if (write.mode) return write.mode
	return write.selector ? 'patch' : 'insert'
}

export function applySignalDbWrite(
	collections: Record<
		string,
		{
			insert: (item: Record<string, unknown>) => string
			updateOne: (
				selector: Record<string, unknown>,
				modifier: { $set: Record<string, unknown> },
				options?: { upsert?: boolean },
			) => 0 | 1
			replaceOne: (
				selector: Record<string, unknown>,
				replacement: Record<string, unknown>,
				options?: { upsert?: boolean },
			) => 0 | 1
			removeOne: (selector: Record<string, unknown>) => 0 | 1
		}
	>,
	write: BuiltinSignalDbWriteSpec,
	scope: Record<string, unknown>,
) {
	const collection = collections[write.collection]
	if (!collection) throw new Error(`signaldb collection not available: ${write.collection}`)

	const mode = normalizeWriteMode(write)
	const resolvedValue = resolveTemplateValue(write.value, scope)
	const selector = write.selector ? { ...write.selector } : undefined

	switch (mode) {
		case 'insert': {
			const payload = ensureDocId(ensureWritableObject(resolvedValue))
			return collection.insert(payload)
		}
		case 'patch': {
			if (!selector) throw new Error('signaldb patch write requires selector')
			return collection.updateOne(
				selector,
				{ $set: ensureWritableObject(resolvedValue) },
				{ upsert: write.upsert },
			)
		}
		case 'replace': {
			if (!selector) throw new Error('signaldb replace write requires selector')
			const payload = ensureWritableObject(resolvedValue)
			if (typeof payload.id !== 'string' && typeof selector.id === 'string')
				payload.id = selector.id
			return collection.replaceOne(selector, payload, { upsert: write.upsert })
		}
		case 'remove': {
			if (!selector) throw new Error('signaldb remove write requires selector')
			return collection.removeOne(selector)
		}
		default:
			throw new Error(`unsupported signaldb write mode: ${String(mode)}`)
	}
}
