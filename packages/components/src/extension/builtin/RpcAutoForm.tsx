import { Box, Button, Group, Loader, Paper, Stack, Text } from '@mantine/core'
import { formOptions } from '@tanstack/react-form'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import * as v from 'valibot'
import * as f from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import type { BuiltinRpcArg, BuiltinRpcAutoFormBlock, ExtensionContext } from '../types'
import { isObject, resolveSseRef, useSseForValues } from './_shared'

type SchemaCacheEntry = { schema: ObjectSchema<any, any>; defaults: Record<string, any> }
const schemaCache = new Map<string, SchemaCacheEntry>()

function normalizeKey(input: unknown): string {
	return typeof input === 'string' ? input.trim() : ''
}

function buildArgsFromTemplate(value: any, args?: BuiltinRpcArg[]) {
	if (!Array.isArray(args) || args.length === 0) return [value]
	return args.map((item) => {
		if (item && typeof item === 'object' && (item as any).kind === 'field') {
			const key = normalizeKey((item as any).key)
			return key ? (value as any)?.[key] : undefined
		}
		return item
	})
}

function safeStringify(input: unknown): string {
	try {
		return JSON.stringify(input)
	} catch {
		return ''
	}
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

function valuesMatch(current: unknown, picked: Record<string, unknown>): boolean {
	if (!current || typeof current !== 'object') return false
	const obj = current as Record<string, unknown>
	for (const key of Object.keys(picked)) {
		if (obj[key] !== picked[key]) return false
	}
	return true
}

function SseSyncSlot({
	enabled,
	payload,
	allowedKeys,
	holdMs,
	lastSuccessSigRef,
	lastSuccessAtRef,
	awaitingSseRef,
}: {
	enabled: boolean
	payload: unknown
	allowedKeys: string[]
	holdMs: number
	lastSuccessSigRef: { current: string }
	lastSuccessAtRef: { current: number }
	awaitingSseRef: { current: boolean }
}) {
	const { reset, defaultValues, form } = useAutoFormCtx<any>()
	const lastSigRef = useRef('')

	useEffect(() => {
		if (!enabled) return
		if (!payload || typeof payload !== 'object') return
		const picked = pickKnownValues(payload, allowedKeys)
		const pickedKeys = Object.keys(picked)
		if (pickedKeys.length === 0) return

		// Avoid clobbering edits mid-submit; for onChange mode this should be rare.
		if ((form.state as any)?.isSubmitting) return
		if ((form.state as any)?.isDirty) return

		const sig = safeStringify(picked)
		if (sig && sig === lastSigRef.current) return

		const currentValues = (form.state as any)?.values
		if (valuesMatch(currentValues, picked)) {
			lastSigRef.current = sig
			if (awaitingSseRef.current) {
				const lastSuccessSig = lastSuccessSigRef.current
				if (sig && lastSuccessSig && sig === lastSuccessSig) {
					awaitingSseRef.current = false
				}
			}
			return
		}

		if (awaitingSseRef.current) {
			const lastSuccessSig = lastSuccessSigRef.current
			const lastSuccessAt = lastSuccessAtRef.current
			const withinHold = lastSuccessAt > 0 && Date.now() - lastSuccessAt < holdMs
			if (sig && lastSuccessSig && sig === lastSuccessSig) {
				awaitingSseRef.current = false
			} else if (withinHold) {
				return
			} else {
				awaitingSseRef.current = false
			}
		}

		lastSigRef.current = sig

		reset({ ...(defaultValues ?? {}), ...picked })
	}, [
		allowedKeys,
		defaultValues,
		enabled,
		form.state,
		payload,
		reset,
		holdMs,
		awaitingSseRef,
		lastSuccessSigRef,
		lastSuccessAtRef,
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
	lastSuccessSigRef,
}: {
	enabled: boolean
	debounceMs: number
	values: unknown
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
	onSubmit: () => void
	lastSuccessSigRef: { current: string }
}) {
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const lastScheduledSigRef = useRef('')

	useEffect(() => {
		if (!enabled) return
		if (!dirty) return
		if (!canSubmit) return
		if (submitting) return

		const sig = safeStringify(values)
		if (sig && sig === lastSuccessSigRef.current) return
		if (sig && sig === lastScheduledSigRef.current) return
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
	}, [canSubmit, debounceMs, dirty, enabled, lastSuccessSigRef, onSubmit, submitting, values])

	return null
}

function AutoSubmitSlot({
	enabled,
	debounceMs,
	lastSuccessSigRef,
}: {
	enabled: boolean
	debounceMs: number
	lastSuccessSigRef: { current: string }
}) {
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
					lastSuccessSigRef={lastSuccessSigRef}
				/>
			)}
		</form.Subscribe>
	)
}

function disposeRpcClient(client: any) {
	const disposer = client?.[Symbol.dispose] ?? client?.[Symbol.asyncDispose] ?? client?.dispose
	if (typeof disposer === 'function') {
		try {
			disposer.call(client)
		} catch {}
	}
}

async function loadSchema(
	ctx: ExtensionContext,
	pluginName: string,
	schemaKey: string,
): Promise<SchemaCacheEntry> {
	const cacheKey = `${pluginName}::${schemaKey}`
	const cached = schemaCache.get(cacheKey)
	if (cached) return cached

	const hmr = (ctx.services as any)?.hmr
	const rawRpc = hmr?.rawRpc
	if (typeof rawRpc !== 'function') {
		throw new Error('rpcAutoForm requires ctx.services.hmr.rawRpc')
	}
	const client = rawRpc()
	let result: any
	try {
		result = await client.plugin(pluginName).schema()
	} finally {
		disposeRpcClient(client)
	}
	if (!result || result.ok === false) {
		throw new Error(result?.message ?? result?.code ?? 'schema_not_found')
	}

	const expr = (result.schemaSource ?? {})[schemaKey]
	if (typeof expr !== 'string' || !expr.trim())
		throw new Error(`schema key not found: ${schemaKey}`)

	const schema = new Function('v', 'f', `return ${expr}`)(v, f)
	if (schema instanceof Promise) {
		throw new Error('async schema not supported in rpcAutoForm yet')
	}

	const defaults = (result.defaults?.[schemaKey] ?? {}) as Record<string, any>
	const entry: SchemaCacheEntry = { schema, defaults }
	schemaCache.set(cacheKey, entry)
	return entry
}

export function BuiltinRpcAutoForm({
	ctx,
	pluginName,
	block,
}: {
	ctx: ExtensionContext
	pluginName: string
	block: BuiltinRpcAutoFormBlock
}) {
	const mountedRef = useRef(true)
	useEffect(() => {
		mountedRef.current = true
		return () => {
			mountedRef.current = false
		}
	}, [])

	const schemaKey = normalizeKey(block.schemaKey)
	const submitMode = block.submitMode ?? 'manual'
	const autoSubmitDebounceMs =
		typeof block.autoSubmitDebounceMs === 'number' && block.autoSubmitDebounceMs >= 0
			? block.autoSubmitDebounceMs
			: 250
	const sseSyncHoldMs =
		typeof block.syncHoldMs === 'number' && block.syncHoldMs >= 0
			? block.syncHoldMs
			: Math.max(800, autoSubmitDebounceMs * 4)
	const lastSuccessSigRef = useRef('')
	const lastSuccessAtRef = useRef(0)
	const awaitingSseRef = useRef(false)

	const [state, setState] = useState<
		| { status: 'loading' }
		| { status: 'error'; error: Error }
		| { status: 'ready'; schema: ObjectSchema<any, any>; defaults: Record<string, any> }
	>({ status: 'loading' })

	useEffect(() => {
		if (!schemaKey) {
			setState({ status: 'error', error: new Error('schemaKey is required') })
			return
		}
		let cancelled = false
		setState({ status: 'loading' })
		void loadSchema(ctx, pluginName, schemaKey)
			.then((entry) => {
				if (cancelled) return
				setState({ status: 'ready', schema: entry.schema, defaults: entry.defaults })
			})
			.catch((e) => {
				if (cancelled) return
				setState({
					status: 'error',
					error: e instanceof Error ? e : new Error('schema load failed'),
				})
			})
		return () => {
			cancelled = true
		}
	}, [ctx, pluginName, schemaKey])

	const notifySuccess = (titleFallback: string) => {
		const notify = ctx.services.ui?.notify
		const success = block.feedback?.success
		if (typeof notify !== 'function' || !success) return
		notify({
			tone: 'success',
			title: success?.title ?? titleFallback,
			message: success?.message,
			...(success ?? {}),
		})
	}

	const notifyError = (err: unknown) => {
		const notify = ctx.services.ui?.notify
		const error = block.feedback?.error
		if (typeof notify !== 'function' || !error) return
		notify({
			tone: 'error',
			title: error?.title ?? '提交失败',
			message:
				error?.message ?? (err instanceof Error ? err.message : String(err ?? 'unknown error')),
			...(error ?? {}),
		})
	}

	const [submitting, setSubmitting] = useState(false)

	const sseStateByEvent = useSseForValues(ctx, pluginName, [block.syncFromSse as any])
	const syncPayload = useMemo(() => {
		const ref: any = block.syncFromSse
		if (!isObject(ref) || ref.kind !== 'sse') return null
		return resolveSseRef(ref as any, sseStateByEvent)
	}, [block.syncFromSse, sseStateByEvent])

	const opts = useMemo(() => {
		if (state.status !== 'ready') return null
		const initialValue = state.defaults ?? {}
		return formOptions({
			defaultValues: initialValue,
			onSubmit: async ({ value, formApi }) => {
				if (submitting) return

				const confirm = block.confirm
				if (confirm?.message) {
					const ok = await (async () => {
						const svc = ctx.services.ui?.confirm
						if (typeof svc === 'function') {
							try {
								return Boolean(await svc(confirm))
							} catch {
								return false
							}
						}
						if (typeof window !== 'undefined') return window.confirm(confirm.message)
						return true
					})()
					if (!ok) return
				}

				setSubmitting(true)
				try {
					const method = String(block.rpc?.method ?? '').trim()
					if (!method) throw new Error('Missing rpc.method')
					const rpcNs = (ctx.services as any)?.hmr?.rpc?.[pluginName]
					const fn = rpcNs?.[method]
					if (typeof fn !== 'function')
						throw new Error(`RPC method not found: ${pluginName}.${method}`)

					const args = buildArgsFromTemplate(value, block.rpc?.args)
					await fn(...args)

					lastSuccessSigRef.current = safeStringify(value)
					lastSuccessAtRef.current = Date.now()
					const hasSseSync = submitMode === 'onChange' && Boolean(block.syncFromSse)
					awaitingSseRef.current = hasSseSync
					notifySuccess('提交成功')
					if (block.resetOnSuccess) {
						formApi.reset()
					} else if (block.submitMode === 'onChange' && !hasSseSync) {
						formApi.reset(value as any)
					}
				} catch (e) {
					notifyError(e)
				} finally {
					if (mountedRef.current) setSubmitting(false)
				}
			},
		})
	}, [
		ctx.services,
		block.confirm,
		block.feedback,
		block.resetOnSuccess,
		block.rpc?.args,
		block.rpc?.method,
		block.syncFromSse,
		pluginName,
		state.status,
		state.status === 'ready' ? state.defaults : null,
		submitting,
		submitMode,
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
					{block.title ?? 'Form'}
				</Text>
				<Text size="xs" c="red" mt={6}>
					{state.error.message}
				</Text>
			</Paper>
		)
	}

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="sm">
				{block.title ? (
					<Box>
						<Text size="sm" fw={650} style={{ lineHeight: 1.2 }}>
							{block.title}
						</Text>
						{block.description ? (
							<Text size="xs" c="dimmed" mt={4}>
								{block.description}
							</Text>
						) : null}
					</Box>
				) : null}

				<AutoForm schema={state.schema as any} formOpts={opts as any}>
					<SseSyncSlot
						enabled={submitMode === 'onChange' && Boolean(block.syncFromSse)}
						payload={syncPayload}
						allowedKeys={Object.keys(state.defaults ?? {})}
						holdMs={sseSyncHoldMs}
						lastSuccessSigRef={lastSuccessSigRef}
						lastSuccessAtRef={lastSuccessAtRef}
						awaitingSseRef={awaitingSseRef}
					/>
					<AutoSubmitSlot
						enabled={submitMode === 'onChange'}
						debounceMs={autoSubmitDebounceMs}
						lastSuccessSigRef={lastSuccessSigRef}
					/>
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
