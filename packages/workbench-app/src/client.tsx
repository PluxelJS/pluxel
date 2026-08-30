import {
	Button,
	Center,
	ColorSchemeScript,
	Paper,
	PasswordInput,
	PinInput,
	Stack,
	Text,
	Title,
} from '@mantine/core'
import type { ManagementAuthenticationProviderStep } from '@pluxel/runtime'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type { RuntimeAuthenticationTarget } from '@pluxel/runtime/web/session'
import React, { useEffect, useState, type FormEvent } from 'react'
import ReactDOM from 'react-dom/client'
import { AppThemeProvider } from './app/AppThemeProvider.tsx'
import { App } from './app/index.tsx'
import {
	createRuntimeSessionClient,
	type RuntimeClientBootstrap,
	type RuntimeSessionEvent,
} from './runtime'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

type GateState =
	| Readonly<{ kind: 'loading' }>
	| Readonly<{
			kind: 'challenge'
			authentication: RpcStub<RuntimeAuthenticationTarget>
			challenge: Extract<ManagementAuthenticationProviderStep, { kind: 'challenge' }>['challenge']
			submitting: boolean
			error?: string
	  }>
	| Readonly<{
			kind: 'ready'
			bootstrap: Extract<RuntimeClientBootstrap, { kind: 'workbench' }>
	  }>
	| Readonly<{ kind: 'invalidated'; cause: RuntimeSessionEvent['cause'] }>
	| Readonly<{ kind: 'error'; error: Error }>

const sessionEvents = new EventTarget()
const SESSION_EVENT = 'pluxel-runtime-session'
type SessionSignal = RuntimeSessionEvent | Readonly<{ kind: 'broken'; error: unknown }>
let terminalSessionSignal: SessionSignal | undefined

function publishSessionEvent(detail: SessionSignal) {
	if (terminalSessionSignal?.kind === 'epoch-invalidated' && detail.kind === 'broken') return
	terminalSessionSignal = detail
	sessionEvents.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail }))
}

const runtimeSession = createRuntimeSessionClient({
	onBroken: (error) => publishSessionEvent({ kind: 'broken', error }),
})
const sessionObserver = (event: RuntimeSessionEvent) => publishSessionEvent(event)
const initialBootstrap = runtimeSession.bootstrap(sessionObserver)

ReactDOM.createRoot(document.querySelector('#root') as HTMLElement).render(
	<React.StrictMode>
		<AppThemeProvider>
			<ColorSchemeScript defaultColorScheme="auto" />
			<RuntimeSessionGate />
		</AppThemeProvider>
	</React.StrictMode>,
)

function RuntimeSessionGate() {
	const [state, setState] = useState<GateState>({ kind: 'loading' })

	useEffect(() => {
		const apply = (detail: SessionSignal) => {
			if (detail.kind === 'epoch-invalidated') {
				setState({ kind: 'invalidated', cause: detail.cause })
			} else {
				setState((current) =>
					current.kind === 'invalidated'
						? current
						: { kind: 'error', error: toError(detail.error, 'Runtime WebSocket 已断开') },
				)
			}
		}
		const receive = (event: Event) => apply((event as CustomEvent<SessionSignal>).detail)
		sessionEvents.addEventListener(SESSION_EVENT, receive)
		if (terminalSessionSignal) apply(terminalSessionSignal)
		return () => sessionEvents.removeEventListener(SESSION_EVENT, receive)
	}, [])

	useEffect(() => {
		let active = true
		void initialBootstrap
			.then((bootstrap) =>
				active && !terminalSessionSignal ? acceptBootstrap(bootstrap, setState) : undefined,
			)
			.catch((error: unknown) => {
				if (active) setState({ kind: 'error', error: toError(error) })
			})
		return () => {
			active = false
		}
	}, [])

	if (state.kind === 'ready') return <App bootstrap={state.bootstrap} />
	if (state.kind === 'challenge') {
		return <AuthenticationChallenge state={state} setState={setState} />
	}
	if (state.kind === 'invalidated') {
		return (
			<GatePanel title="Workbench 会话已更新">
				<Text c="dimmed">运行时 epoch 已因 {state.cause} 失效，需要重新载入整个页面。</Text>
				<Button onClick={() => window.location.reload()}>重新载入</Button>
			</GatePanel>
		)
	}
	if (state.kind === 'error') {
		return (
			<GatePanel title="无法建立 Workbench 会话">
				<Text c="red">{state.error.message}</Text>
				<Button onClick={() => window.location.reload()}>重试</Button>
			</GatePanel>
		)
	}
	return (
		<GatePanel title="正在准备 Workbench">
			<Text c="dimmed">连接 Runtime，并准备插件与 Workbench 视图…</Text>
			<Text size="xs" c="dimmed">
				首次启动或界面变更后，Runtime 会先生成并验证 MF2 产物。
			</Text>
		</GatePanel>
	)
}

function AuthenticationChallenge({
	state,
	setState,
}: {
	state: Extract<GateState, { kind: 'challenge' }>
	setState: React.Dispatch<React.SetStateAction<GateState>>
}) {
	const [secret, setSecret] = useState('')
	const challenge = state.challenge
	const submit = (event: FormEvent) => {
		event.preventDefault()
		if (state.submitting || !secret) return
		setState({ ...state, submitting: true, error: undefined })
		void readAuthenticationStep(
			state.authentication.submit(
				challenge.kind === 'password' ? { password: secret } : { code: secret },
			),
		)
			.then((step) => acceptAuthenticationStep(state.authentication, step, setState))
			.catch((error: unknown) =>
				setState(() =>
					terminalSessionSignal
						? terminalGateState(terminalSessionSignal)
						: {
								...state,
								submitting: false,
								error: toError(error, '认证请求失败').message,
							},
				),
			)
	}
	return (
		<GatePanel title={challenge.kind === 'password' ? challenge.label || '管理员认证' : '两步验证'}>
			<form onSubmit={submit}>
				<Stack>
					{challenge.kind === 'password' ? (
						<PasswordInput
							autoFocus
							autoComplete="current-password"
							label="密码"
							value={secret}
							onChange={(event) => setSecret(event.currentTarget.value)}
						/>
					) : (
						<PinInput
							autoFocus
							length={challenge.digits}
							type="number"
							value={secret}
							onChange={setSecret}
						/>
					)}
					{state.error ? <Text c="red">{state.error}</Text> : null}
					<Button type="submit" loading={state.submitting} disabled={!secret}>
						继续
					</Button>
				</Stack>
			</form>
		</GatePanel>
	)
}

async function acceptBootstrap(
	bootstrap: RuntimeClientBootstrap,
	setState: React.Dispatch<React.SetStateAction<GateState>>,
): Promise<void> {
	if (terminalSessionSignal) {
		setState(terminalGateState(terminalSessionSignal))
		return
	}
	if (bootstrap.kind === 'workbench') {
		setState({ kind: 'ready', bootstrap })
		return
	}
	if (bootstrap.kind === 'management') {
		throw new Error('此部署未启用核心 Workbench capability')
	}
	const step = await readAuthenticationStep(bootstrap.authentication.state())
	await acceptAuthenticationStep(bootstrap.authentication, step, setState)
}

async function acceptAuthenticationStep(
	authentication: RpcStub<RuntimeAuthenticationTarget>,
	step: ManagementAuthenticationProviderStep,
	setState: React.Dispatch<React.SetStateAction<GateState>>,
): Promise<void> {
	if (terminalSessionSignal) {
		setState(terminalGateState(terminalSessionSignal))
		return
	}
	switch (step.kind) {
		case 'challenge':
			setState({ kind: 'challenge', authentication, challenge: step.challenge, submitting: false })
			return
		case 'navigate':
			window.location.assign(step.path)
			return
		case 'failed':
			setState({ kind: 'error', error: new Error(authenticationFailureMessage(step.code)) })
			return
		case 'authenticated':
			setState({ kind: 'loading' })
			if (step.cookieCommit) await runtimeSession.commitCookie(step.cookieCommit.ticket)
			await acceptBootstrap(await runtimeSession.bootstrap(sessionObserver), setState)
	}
}

function terminalGateState(signal: SessionSignal): GateState {
	return signal.kind === 'epoch-invalidated'
		? { kind: 'invalidated', cause: signal.cause }
		: { kind: 'error', error: toError(signal.error, 'Runtime WebSocket 已断开') }
}

async function readAuthenticationStep(
	input: PromiseLike<ManagementAuthenticationProviderStep> | ManagementAuthenticationProviderStep,
): Promise<ManagementAuthenticationProviderStep> {
	const raw = await input
	try {
		switch (raw.kind) {
			case 'challenge':
				return raw.challenge.kind === 'password'
					? Object.freeze({
							kind: 'challenge' as const,
							challenge: Object.freeze({
								kind: 'password' as const,
								...(raw.challenge.label === undefined ? {} : { label: raw.challenge.label }),
							}),
						})
					: Object.freeze({
							kind: 'challenge' as const,
							challenge: Object.freeze({ kind: 'totp' as const, digits: raw.challenge.digits }),
						})
			case 'navigate':
				return Object.freeze({ kind: 'navigate', path: raw.path })
			case 'failed':
				return Object.freeze({ kind: 'failed', code: raw.code })
			case 'authenticated':
				return Object.freeze({
					kind: 'authenticated' as const,
					principal: Object.freeze({ ...raw.principal }),
					...(raw.cookieCommit ? { cookieCommit: Object.freeze({ ...raw.cookieCommit }) } : {}),
				})
		}
	} finally {
		const dispose = (raw as ManagementAuthenticationProviderStep & Partial<Disposable>)[
			Symbol.dispose
		]
		if (typeof dispose === 'function') dispose.call(raw)
	}
	throw new TypeError('认证 provider 返回了未知步骤')
}

function authenticationFailureMessage(code: string): string {
	switch (code) {
		case 'authentication_failed':
			return '凭据无效'
		case 'authentication_expired':
			return '认证流程已过期，请重新载入'
		case 'attempt_limited':
			return '尝试次数受限，请稍后重试'
		default:
			return '管理员认证当前不可用'
	}
}

function GatePanel({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<Center mih="100vh" p="md">
			<Paper withBorder shadow="sm" radius="md" p="xl" w="min(28rem, 100%)">
				<Stack>
					<Title order={2}>{title}</Title>
					{children}
				</Stack>
			</Paper>
		</Center>
	)
}

function toError(error: unknown, fallback = 'Runtime session 初始化失败'): Error {
	return error instanceof Error ? error : new Error(typeof error === 'string' ? error : fallback)
}
