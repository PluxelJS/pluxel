import { Loader, Paper, Stack, Text } from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InteractionSessionDef } from '@pluxel/runtime/web/extensions'
import type {
	ExtensionSessionLoadResult,
	ExtensionSessionMutationResult,
	InteractionSessionComponent,
	InteractionSessionComponentProps,
} from '@pluxel/runtime/web'
import {
	createPluginExtensionContext,
	ExtensionProvider,
	useExtensionPathname,
	useGlobalExtensionContext,
} from '@pluxel/runtime/web'

type LoadedSessionPayload = {
	input: unknown
	draft: unknown
	prepared: unknown
}

export function InteractionSessionHost({
	session,
	component: SessionComponent,
}: {
	session: InteractionSessionDef
	component: InteractionSessionComponent<any, any, any, any>
}) {
	const ctx = useGlobalExtensionContext()
	const pathname = useExtensionPathname()
	const transport = ctx.services.transport
	const [payload, setPayload] = useState<LoadedSessionPayload | null>(null)
	const [phase, setPhase] = useState<'loading' | 'ready' | 'syncing-draft' | 'committing'>('loading')
	const [error, setError] = useState<Error | null>(null)
	const loadRevisionRef = useRef(0)
	const sessionRevisionRef = useRef(0)
	const providerPluginName = session.providerPluginName || session.pluginName
	const providerCtx = useMemo(
		() =>
			createPluginExtensionContext(ctx, {
				pluginName: providerPluginName,
				pathname,
			}),
		[ctx, pathname, providerPluginName],
	)

	const load = useCallback(async () => {
		const loadRevision = ++loadRevisionRef.current
		const sessionRevision = sessionRevisionRef.current
		setPhase('loading')
		setError(null)
		const result = await transport.withRpc(
			async (rpc): Promise<ExtensionSessionLoadResult> =>
				await (rpc.ui().loadSession(session.id) as unknown as Promise<ExtensionSessionLoadResult>),
		)
		if (
			loadRevision !== loadRevisionRef.current ||
			sessionRevision !== sessionRevisionRef.current
		) {
			return
		}
		if (result.ok !== true) {
			throw new Error(result.message ?? result.code)
		}
		setPayload({
			input: result.input,
			draft: result.draft,
			prepared: result.prepared,
		})
		setPhase('ready')
	}, [session.id, transport])

	useEffect(() => {
		sessionRevisionRef.current += 1
		let disposed = false
		void load().catch((nextError) => {
			if (disposed) return
			setPayload(null)
			setPhase('ready')
			setError(nextError instanceof Error ? nextError : new Error('Failed to load interaction session'))
		})
		return () => {
			disposed = true
		}
	}, [load])

	const setDraft = useCallback(
		(next: unknown | ((prev: unknown) => unknown)) => {
			setPayload((prev) => {
				if (!prev) return prev
				const draft = typeof next === 'function' ? (next as (value: unknown) => unknown)(prev.draft) : next
				return { ...prev, draft }
			})
		},
		[],
	)

	const patchDraft = useCallback((patch: Record<string, unknown>) => {
		setPayload((prev) => {
			if (!prev || !prev.draft || typeof prev.draft !== 'object' || Array.isArray(prev.draft)) return prev
			return {
				...prev,
				draft: {
					...(prev.draft as Record<string, unknown>),
					...(patch ?? {}),
				},
			}
		})
	}, [])

	const pushDraft = useCallback(
		async (nextDraft?: unknown) => {
			const sessionRevision = sessionRevisionRef.current
			const draft = nextDraft === undefined ? payload?.draft : nextDraft
			if (draft === undefined) return
			if (nextDraft !== undefined) {
				setPayload((prev) => (prev ? { ...prev, draft: nextDraft } : prev))
			}
			setPhase('syncing-draft')
			try {
				const result = await transport.withRpc(
					async (rpc): Promise<ExtensionSessionMutationResult> =>
						await (rpc.ui().syncDraft({
							sessionId: session.id,
							draft,
						}) as unknown as Promise<ExtensionSessionMutationResult>),
				)
				if (sessionRevision !== sessionRevisionRef.current) return
				if (result.ok !== true) throw new Error(result.message ?? result.code)
				setPhase('ready')
			} catch (nextError) {
				if (sessionRevision !== sessionRevisionRef.current) return
				setPhase('ready')
				throw nextError
			}
		},
		[payload?.draft, session.id, transport],
	)

	const commit = useCallback(
		async (resultValue: unknown) => {
			const sessionRevision = sessionRevisionRef.current
			setPhase('committing')
			const result = await transport.withRpc(
				async (rpc): Promise<ExtensionSessionMutationResult> =>
					await (rpc.ui().commitSession({
						sessionId: session.id,
						result: resultValue,
					}) as unknown as Promise<ExtensionSessionMutationResult>),
			)
			if (sessionRevision !== sessionRevisionRef.current) return
			if (result.ok !== true) {
				setPhase('ready')
				throw new Error(result.message ?? result.code)
			}
			setPhase('ready')
		},
		[session.id, transport],
	)

	const sessionProps = useMemo<InteractionSessionComponentProps | null>(() => {
		if (!payload) return null
		return {
			sessionId: session.id,
			targetPlugin: session.pluginName,
			providerPlugin: session.providerPluginName,
			surfaceId: session.surfaceId,
			offerId: session.offerId,
			contract: session.contract,
			input: payload.input,
			prepared: payload.prepared,
			draft: payload.draft,
			setDraft,
			patchDraft,
			pushDraft,
			commit,
			reload: load,
			disabled: phase === 'syncing-draft' || phase === 'committing',
			phase: phase === 'loading' ? 'ready' : phase,
		}
	}, [commit, load, patchDraft, payload, phase, pushDraft, session, setDraft])

	if (phase === 'loading' && !payload) {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Stack gap="xs">
					<Text size="xs" c="dimmed">
						正在准备交互面板…
					</Text>
					<Loader size="sm" />
				</Stack>
			</Paper>
		)
	}

	if (error) {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Text size="sm" c="red">
					Failed to load interaction session: {error.message}
				</Text>
			</Paper>
		)
	}

	if (!sessionProps) return null
	return (
		<ExtensionProvider value={providerCtx}>
			<SessionComponent {...sessionProps} />
		</ExtensionProvider>
	)
}
