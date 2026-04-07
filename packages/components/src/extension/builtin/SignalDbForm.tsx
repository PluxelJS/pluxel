import { Box, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BuiltinFormBlock } from '@pluxel/runtime/web/extensions'
import {
	type RuntimeTransportClient,
	useGlobalExtensionContext,
	useSignalDbCollectionsState,
	useSignalDbQueryState,
} from '@pluxel/runtime/web'
import type { ObjectSchema } from 'valibot'
import * as v from 'valibot'
import * as f from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import { applySignalDbWrite, isObject, resolveSignalDbRef } from './_shared'

type SchemaCacheEntry = { schema: ObjectSchema<any, any>; defaults: Record<string, any> }
const schemaCache = new Map<string, SchemaCacheEntry>()

type SchemaLoadState =
	| { status: 'loading' }
	| { status: 'error'; error: Error }
	| { status: 'ready'; schema: ObjectSchema<any, any>; defaults: Record<string, any> }

function normalizeKey(input: unknown): string {
	return typeof input === 'string' ? input.trim() : ''
}

function safeStringify(input: unknown): string {
	try {
		return JSON.stringify(input)
	} catch {
		return ''
	}
}

function valuesMatch(current: unknown, next: Record<string, unknown>): boolean {
	if (!current || typeof current !== 'object') return false
	const obj = current as Record<string, unknown>
	for (const [key, value] of Object.entries(next)) {
		if (obj[key] !== value) return false
	}
	return true
}

function pickKnownValues(source: unknown, allowedKeys: string[]): Record<string, unknown> {
	if (!source || typeof source !== 'object') return {}
	const obj = source as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const key of allowedKeys) {
		if (Object.hasOwn(obj, key)) out[key] = obj[key]
	}
	return out
}

function SyncSlot({
	enabled,
	payload,
	allowedKeys,
	optimisticSync,
	onOptimisticSyncSettled,
}: {
	enabled: boolean
	payload: unknown
	allowedKeys: string[]
	optimisticSync: { sig: string; at: number } | null
	onOptimisticSyncSettled: () => void
}): null {
	const { reset, defaultValues, form } = useAutoFormCtx<any>()
	const lastSigRef = useRef('')

	useEffect(() => {
		if (!enabled) return undefined
		if (!payload || typeof payload !== 'object') return undefined
		const picked = pickKnownValues(payload, allowedKeys)
		if (Object.keys(picked).length === 0) return undefined

		const currentValues = (form.state as any)?.values
		const sig = safeStringify(picked)
		if (valuesMatch(currentValues, picked)) {
			if (sig) lastSigRef.current = sig
			if ((form.state as any)?.isDirty || optimisticSync) {
				reset({ ...defaultValues, ...picked })
			}
			if (optimisticSync) onOptimisticSyncSettled()
			return undefined
		}

		if ((form.state as any)?.isSubmitting) return undefined
		if ((form.state as any)?.isDirty) return undefined
		if (optimisticSync) {
			if (sig && sig === optimisticSync.sig) {
				lastSigRef.current = sig
				onOptimisticSyncSettled()
				return undefined
			}
			return undefined
		}
		if (sig && sig === lastSigRef.current) return undefined
		if (valuesMatch((form.state as any)?.values, picked)) {
			lastSigRef.current = sig
			return undefined
		}

		lastSigRef.current = sig
		reset({ ...defaultValues, ...picked })
		return undefined
	}, [
		allowedKeys,
		defaultValues,
		enabled,
		form.state,
		onOptimisticSyncSettled,
		optimisticSync,
		payload,
		reset,
	])

	return null
}

function AutoSubmitController({
	enabled,
	debounceMs,
	values,
	dirty,
	canSubmit,
	submitting,
	onSubmit,
}: {
	enabled: boolean
	debounceMs: number
	values: unknown
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
	onSubmit: () => void
}): null {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const lastScheduledSigRef = useRef('')

	useEffect(() => {
		if (!enabled || !dirty || !canSubmit || submitting) return undefined

		const sig = safeStringify(values)
		if (sig && sig === lastScheduledSigRef.current) return undefined
		lastScheduledSigRef.current = sig

		if (timerRef.current) clearTimeout(timerRef.current)
		timerRef.current = setTimeout(
			() => {
				onSubmit()
			},
			Math.max(0, debounceMs),
		)

		return () => {
			if (timerRef.current) clearTimeout(timerRef.current)
			timerRef.current = null
		}
	}, [canSubmit, debounceMs, dirty, enabled, onSubmit, submitting, values])

	return null
}

function AutoSubmitSlot({ enabled, debounceMs }: { enabled: boolean; debounceMs: number }) {
	const { form, submit } = useAutoFormCtx<any>()
	return (
		<form.Subscribe
			selector={(s: any) => ({
				values: s.values,
				dirty: s.isDirty,
				canSubmit: s.canSubmit,
				submitting: s.isSubmitting,
			})}
		>
			{({ values, dirty, canSubmit, submitting }) => (
				<AutoSubmitController
					enabled={enabled}
					debounceMs={debounceMs}
					values={values}
					dirty={dirty}
					canSubmit={canSubmit}
					submitting={submitting}
					onSubmit={submit}
				/>
			)}
		</form.Subscribe>
	)
}

function useSignalDbFormSchema(
	transport: RuntimeTransportClient | null,
	pluginName: string,
	schemaKey: string,
): SchemaLoadState {
	const [state, setState] = useState<SchemaLoadState>({ status: 'loading' })

	useEffect(() => {
		if (!schemaKey) {
			setState({ status: 'error', error: new Error('schemaKey is required') })
			return undefined
		}
		if (!transport) {
			setState({ status: 'error', error: new Error('doc form requires ctx.services.transport') })
			return undefined
		}

		let cancelled = false
		setState({ status: 'loading' })
		void (async () => {
			try {
				const entry = await loadSchema(transport, pluginName, schemaKey)
				if (cancelled) return
				setState({ status: 'ready', schema: entry.schema, defaults: entry.defaults })
			} catch (error) {
				if (cancelled) return
				setState({
					status: 'error',
					error: error instanceof Error ? error : new Error('schema load failed'),
				})
			}
		})()

		return () => {
			cancelled = true
		}
	}, [pluginName, schemaKey, transport])

	return state
}

async function loadSchema(
	transport: RuntimeTransportClient,
	pluginName: string,
	schemaKey: string,
): Promise<SchemaCacheEntry> {
	const cacheKey = `${pluginName}::${schemaKey}`
	const cached = schemaCache.get(cacheKey)
	if (cached) return cached

	const result: any = await transport.withRpc((client: any) => client.plugin(pluginName).schema())
	if (!result || result.ok === false) {
		throw new Error(result?.message ?? result?.code ?? 'schema_not_found')
	}

	const expr = (result.schemaSource ?? {})[schemaKey]
	if (typeof expr !== 'string' || !expr.trim())
		throw new Error(`schema key not found: ${schemaKey}`)

	const schema = new Function('v', 'f', `return ${expr}`)(v, f)
	if (schema instanceof Promise) throw new Error('async schema not supported in doc form yet')

	const defaults = (result.defaults?.[schemaKey] ?? {}) as Record<string, any>
	const entry: SchemaCacheEntry = { schema, defaults }
	schemaCache.set(cacheKey, entry)
	return entry
}

export function BuiltinSignalDbForm({
	pluginName,
	title,
	block,
}: {
	pluginName: string
	title: string
	block: BuiltinFormBlock
}) {
	const ctx = useGlobalExtensionContext()
	const transport = ctx.services.transport
	const isMountedRef = useRef(true)
	useEffect(() => {
		return () => {
			isMountedRef.current = false
		}
	}, [])

	const schemaKey = normalizeKey(block.schemaKey)
	const submitMode = block.submitMode ?? 'manual'
	const autoSubmitDebounceMs =
		typeof block.autoSubmitDebounceMs === 'number' && block.autoSubmitDebounceMs >= 0
			? block.autoSubmitDebounceMs
			: 250

	const state = useSignalDbFormSchema(transport, pluginName, schemaKey)
	const collections = useSignalDbCollectionsState(
		transport,
		pluginName,
		useMemo(() => {
			const names = new Set<string>([block.write.collection])
			if (block.syncFrom?.collection) names.add(block.syncFrom.collection)
			return Array.from(names)
		}, [block.syncFrom?.collection, block.write.collection]),
	)

	const syncPayload = useSignalDbQueryState(() => {
		if (!block.syncFrom || !isObject(block.syncFrom)) return null
		return resolveSignalDbRef(block.syncFrom, collections as any)
	}, [block.syncFrom, collections])

	const allowedKeys = useMemo(() => {
		if (state.status !== 'ready') return []
		return Object.keys(state.defaults ?? {})
	}, [state.status, state.status === 'ready' ? state.defaults : null])

	const notifySuccess = (titleFallback: string) => {
		const notify = ctx.services.ui.notify
		const success = block.feedback?.success
		if (!success) return
		notify({
			tone: 'success',
			title: success.title ?? titleFallback,
			message: success.message,
			...success,
		})
	}

	const notifyError = (err: unknown) => {
		const notify = ctx.services.ui.notify
		const error = block.feedback?.error
		if (!error) return
		notify({
			tone: 'error',
			title: error.title ?? '提交失败',
			message:
				error.message ?? (err instanceof Error ? err.message : String(err ?? 'unknown error')),
			...error,
		})
	}

	const [submitting, setSubmitting] = useState(false)
	const [optimisticSync, setOptimisticSync] = useState<{ sig: string; at: number } | null>(null)

	useEffect(() => {
		if (!optimisticSync) return undefined
		const timer = setTimeout(() => {
			setOptimisticSync((current) =>
				current && current.sig === optimisticSync.sig && current.at === optimisticSync.at
					? null
					: current,
			)
		}, 1_500)
		return () => clearTimeout(timer)
	}, [optimisticSync])

	const formOpts = useMemo(() => {
		if (state.status !== 'ready') return null
		return formOptions({
			defaultValues: state.defaults ?? {},
			onSubmit: async ({ value, formApi }) => {
				if (submitting) return

				const confirm = block.confirm
				if (confirm?.message) {
					const ok = await ctx.services.ui.confirm(confirm)
					if (!ok) return
				}

				setSubmitting(true)
				try {
					applySignalDbWrite(collections as any, block.write, value as Record<string, unknown>)
					if (block.syncFrom) {
						const submitted = pickKnownValues(value as Record<string, unknown>, allowedKeys)
						const sig = safeStringify(submitted)
						if (sig) {
							setOptimisticSync({
								sig,
								at: Date.now(),
							})
						}
					}
					notifySuccess(title || '已提交')
					if (block.resetOnSuccess) formApi.reset()
					else if (submitMode !== 'onChange' || !block.syncFrom) formApi.reset(value as any)
				} catch (error) {
					setOptimisticSync(null)
					notifyError(error)
				} finally {
					if (isMountedRef.current) setSubmitting(false)
				}
			},
		})
	}, [
		allowedKeys,
		block.confirm,
		block.feedback,
		block.resetOnSuccess,
		block.syncFrom,
		submitMode,
		block.write,
		collections,
		ctx.services,
		state.status,
		state.status === 'ready' ? state.defaults : null,
		submitting,
		title,
	])

	if (state.status === 'loading') {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Group gap={8}>
					<Loader size="sm" />
					<Text size="sm" c="dimmed">
						加载表单中…
					</Text>
				</Group>
			</Paper>
		)
	}

	if (state.status === 'error') {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Text size="sm" fw={650}>
					{title || 'Form'}
				</Text>
				{block.description ? (
					<Text size="xs" c="dimmed" mt={6}>
						{block.description}
					</Text>
				) : null}
				<Text size="xs" c="red" mt={6}>
					{state.error.message}
				</Text>
			</Paper>
		)
	}

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="sm">
				{block.description ? (
					<Text size="xs" c="dimmed">
						{block.description}
					</Text>
				) : null}

				<AutoForm schema={state.schema as any} formOpts={formOpts as any}>
					<SyncSlot
						enabled={Boolean(block.syncFrom)}
						payload={syncPayload}
						allowedKeys={allowedKeys}
						optimisticSync={optimisticSync}
						onOptimisticSyncSettled={() => setOptimisticSync(null)}
					/>
					<AutoSubmitSlot enabled={submitMode === 'onChange'} debounceMs={autoSubmitDebounceMs} />
					<Box px="xs" pb={6}>
						<AutoForm.Fields />
					</Box>
					{submitMode === 'manual' ? (
						<AutoForm.Actions>
							{({ submit, canSubmit }) => (
								<Group justify="flex-end">
									<Button
										size="xs"
										variant="light"
										onClick={submit}
										disabled={!canSubmit || submitting}
									>
										{submitting ? (
											<Group gap={6} wrap="nowrap">
												<Loader size="xs" />
												<Text size="xs">提交中…</Text>
											</Group>
										) : (
											(block.submitLabel ?? 'Submit')
										)}
									</Button>
								</Group>
							)}
						</AutoForm.Actions>
					) : null}
				</AutoForm>
			</Stack>
		</Paper>
	)
}
