import {
	Alert,
	Button,
	Card,
	Code,
	CopyButton,
	Group,
	Loader,
	MantineProvider,
	PasswordInput,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import '@mantine/core/styles.css'
import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { IconCheck, IconCopy, IconKey, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
	AuthWorkbench,
	type AuthPasswordSetupInput,
	type AuthSetupFailure,
	type AuthSetupMutationResult,
	type AuthSetupSnapshot,
	type AuthTotpEnrollment,
	type AuthTotpEnrollmentResult,
} from '../workbench.ts'

function disposeRemoteValue(input: unknown): void {
	const dispose =
		input && (typeof input === 'object' || typeof input === 'function')
			? (input as Partial<Disposable>)[Symbol.dispose]
			: undefined
	if (typeof dispose === 'function') dispose.call(input)
}

function copySnapshot(input: AuthSetupSnapshot): AuthSetupSnapshot {
	if (input.state === 'configured') {
		return Object.freeze({ mode: input.mode, state: 'configured' })
	}
	if (input.state === 'unavailable') {
		return Object.freeze({ mode: input.mode, state: 'unavailable', reason: input.reason })
	}
	return Object.freeze({ mode: input.mode, state: 'setup-required', reason: input.reason })
}

function copyFailure(input: AuthSetupFailure): AuthSetupFailure {
	return Object.freeze({ ok: false, code: input.code, message: input.message })
}

function copyMutationResult(input: AuthSetupMutationResult): AuthSetupMutationResult {
	return input.ok === false
		? copyFailure(input)
		: Object.freeze({ ok: true, snapshot: copySnapshot(input.snapshot) })
}

function copyEnrollmentResult(input: AuthTotpEnrollmentResult): AuthTotpEnrollmentResult {
	if (input.ok === false) return copyFailure(input)
	return Object.freeze({
		ok: true,
		enrollment: Object.freeze({
			id: input.enrollment.id,
			secret: input.enrollment.secret,
			provisioningUri: input.enrollment.provisioningUri,
			expiresAt: input.enrollment.expiresAt,
		}),
	})
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export default function AuthSetup() {
	const { api, host } = useWorkbench(AuthWorkbench.setup)
	const requestId = useRef(0)
	const [snapshot, setSnapshot] = useState<AuthSetupSnapshot>()
	const [loading, setLoading] = useState(true)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const [passwordConfirmation, setPasswordConfirmation] = useState('')
	const [oidcSecret, setOidcSecret] = useState('')
	const [enrollment, setEnrollment] = useState<AuthTotpEnrollment>()
	const [totpCode, setTotpCode] = useState('')

	const refresh = useCallback(async () => {
		const current = ++requestId.current
		setLoading(true)
		try {
			const remote = await api.snapshot()
			try {
				if (requestId.current === current) {
					setSnapshot(copySnapshot(remote))
					setError(undefined)
				}
			} finally {
				disposeRemoteValue(remote)
			}
		} catch (caught) {
			if (requestId.current === current) setError(messageOf(caught))
		} finally {
			if (requestId.current === current) setLoading(false)
		}
	}, [api])

	useEffect(() => {
		void refresh()
		return () => {
			requestId.current += 1
		}
	}, [refresh])

	const clearSecrets = () => {
		setPassword('')
		setPasswordConfirmation('')
		setOidcSecret('')
		setTotpCode('')
		setEnrollment(undefined)
	}

	const applyMutation = async (
		operation: () => PromiseLike<AuthSetupMutationResult>,
	): Promise<boolean> => {
		if (busy) return false
		setBusy(true)
		try {
			const remote = await operation()
			let result: AuthSetupMutationResult
			try {
				result = copyMutationResult(remote)
			} finally {
				disposeRemoteValue(remote)
			}
			if (result.ok === false) {
				setError(result.message)
				if (result.code === 'not_required') await refresh()
				return false
			}
			setSnapshot(result.snapshot)
			setError(undefined)
			clearSecrets()
			return true
		} catch (caught) {
			setError(messageOf(caught))
			return false
		} finally {
			setBusy(false)
		}
	}

	const passwordInput = (): AuthPasswordSetupInput => ({
		username,
		password,
		passwordConfirmation,
	})

	const submitPassword = async (event: FormEvent) => {
		event.preventDefault()
		await applyMutation(() => api.setupPassword(passwordInput()))
	}

	const beginTotp = async (event: FormEvent) => {
		event.preventDefault()
		if (busy) return
		setBusy(true)
		try {
			const remote = await api.beginTotp(passwordInput())
			let result: AuthTotpEnrollmentResult
			try {
				result = copyEnrollmentResult(remote)
			} finally {
				disposeRemoteValue(remote)
			}
			if (result.ok === false) {
				setError(result.message)
				if (result.code === 'not_required') await refresh()
				return
			}
			setEnrollment(result.enrollment)
			setPassword('')
			setPasswordConfirmation('')
			setError(undefined)
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			setBusy(false)
		}
	}

	const confirmTotp = async (event: FormEvent) => {
		event.preventDefault()
		if (!enrollment) return
		await applyMutation(() => api.confirmTotp({ enrollmentId: enrollment.id, code: totpCode }))
	}

	const submitOidcSecret = async (event: FormEvent) => {
		event.preventDefault()
		await applyMutation(() => api.setupOidcSecret({ secret: oidcSecret }))
	}

	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Stack gap="md" p="md" maw={760}>
				<Group justify="space-between" align="flex-start">
					<Stack gap={2}>
						<Title order={3}>Authentication setup</Title>
						<Text size="sm" c="dimmed">
							Provision the first credential for this Auth Plugin generation.
						</Text>
					</Stack>
					<Button
						variant="light"
						leftSection={<IconRefresh size={16} />}
						loading={loading}
						disabled={busy}
						onClick={() => void refresh()}
					>
						Refresh
					</Button>
				</Group>

				{error ? <Alert color="red">{error}</Alert> : null}

				{loading && !snapshot ? (
					<Group>
						<Loader size="sm" />
						<Text>Reading credential state…</Text>
					</Group>
				) : null}

				{snapshot?.state === 'configured' ? (
					<Alert color="green" icon={<IconCheck size={18} />} title="Authentication is ready">
						{snapshot.mode === 'oidc-public'
							? 'This public OIDC client does not require a client secret.'
							: 'The first credential is configured. Credential rotation is intentionally not exposed on this setup page.'}
					</Alert>
				) : null}

				{snapshot?.state === 'unavailable' ? (
					<Alert color="yellow" title="Vault is unavailable">
						This credential mode needs persistent Vault storage. Enable Vault or provision the
						credential in a host that uses the same persistence.
					</Alert>
				) : null}

				{snapshot?.state === 'setup-required' ? (
					<Alert color={snapshot.reason === 'invalid' ? 'red' : 'blue'}>
						{snapshot.reason === 'invalid'
							? 'The stored credential record is invalid. Local recovery may replace it once.'
							: 'No credential has been stored for the configured authentication mode.'}
					</Alert>
				) : null}

				{snapshot?.state === 'setup-required' && snapshot.mode === 'password' ? (
					<PasswordAccountForm
						username={username}
						password={password}
						passwordConfirmation={passwordConfirmation}
						busy={busy}
						onUsername={setUsername}
						onPassword={setPassword}
						onPasswordConfirmation={setPasswordConfirmation}
						onSubmit={(event) => void submitPassword(event)}
					/>
				) : null}

				{snapshot?.state === 'setup-required' && snapshot.mode === 'password-totp' ? (
					enrollment ? (
						<Card withBorder>
							<form onSubmit={(event) => void confirmTotp(event)}>
								<Stack gap="md">
									<Stack gap={4}>
										<Text fw={600}>Enroll a TOTP authenticator</Text>
										<Text size="sm" c="dimmed">
											Add the secret to your authenticator, then enter its current six-digit code.
										</Text>
									</Stack>
									<SecretValue label="Base32 secret" value={enrollment.secret} />
									<SecretValue label="Provisioning URI" value={enrollment.provisioningUri} />
									<Text size="xs" c="dimmed">
										Enrollment expires at {new Date(enrollment.expiresAt).toLocaleString()}.
									</Text>
									<TextInput
										label="One-time code"
										inputMode="numeric"
										maxLength={6}
										value={totpCode}
										disabled={busy}
										onChange={(event) =>
											setTotpCode(event.currentTarget.value.replaceAll(/\D/g, '').slice(0, 6))
										}
									/>
									<Group>
										<Button type="submit" loading={busy} disabled={totpCode.length !== 6}>
											Confirm and save
										</Button>
										<Button
											variant="subtle"
											disabled={busy}
											onClick={() => {
												setEnrollment(undefined)
												setTotpCode('')
											}}
										>
											Start over
										</Button>
									</Group>
								</Stack>
							</form>
						</Card>
					) : (
						<PasswordAccountForm
							username={username}
							password={password}
							passwordConfirmation={passwordConfirmation}
							busy={busy}
							submitLabel="Continue to TOTP"
							onUsername={setUsername}
							onPassword={setPassword}
							onPasswordConfirmation={setPasswordConfirmation}
							onSubmit={(event) => void beginTotp(event)}
						/>
					)
				) : null}

				{snapshot?.state === 'setup-required' && snapshot.mode === 'oidc-confidential' ? (
					<Card withBorder>
						<form onSubmit={(event) => void submitOidcSecret(event)}>
							<Stack gap="md">
								<PasswordInput
									label="OIDC client secret"
									description="The value is persisted in Vault and is never returned by this API."
									value={oidcSecret}
									disabled={busy}
									onChange={(event) => setOidcSecret(event.currentTarget.value)}
								/>
								<Button type="submit" loading={busy} disabled={oidcSecret.length === 0}>
									Save client secret
								</Button>
							</Stack>
						</form>
					</Card>
				) : null}
			</Stack>
		</MantineProvider>
	)
}

type PasswordAccountFormProps = Readonly<{
	username: string
	password: string
	passwordConfirmation: string
	busy: boolean
	submitLabel?: string
	onUsername(value: string): void
	onPassword(value: string): void
	onPasswordConfirmation(value: string): void
	onSubmit(event: FormEvent): void
}>

function PasswordAccountForm({
	username,
	password,
	passwordConfirmation,
	busy,
	submitLabel = 'Save credential',
	onUsername,
	onPassword,
	onPasswordConfirmation,
	onSubmit,
}: PasswordAccountFormProps) {
	return (
		<Card withBorder>
			<form onSubmit={onSubmit}>
				<Stack gap="md">
					<TextInput
						label="Account name"
						maxLength={128}
						value={username}
						disabled={busy}
						onChange={(event) => onUsername(event.currentTarget.value)}
					/>
					<PasswordInput
						label="Password"
						description="Use at least 12 characters."
						value={password}
						disabled={busy}
						onChange={(event) => onPassword(event.currentTarget.value)}
					/>
					<PasswordInput
						label="Confirm password"
						value={passwordConfirmation}
						disabled={busy}
						onChange={(event) => onPasswordConfirmation(event.currentTarget.value)}
					/>
					<Button
						type="submit"
						loading={busy}
						disabled={
							username.trim().length === 0 ||
							password.length < 12 ||
							passwordConfirmation.length === 0
						}
					>
						{submitLabel}
					</Button>
				</Stack>
			</form>
		</Card>
	)
}

function SecretValue({ label, value }: Readonly<{ label: string; value: string }>) {
	return (
		<Stack gap={4}>
			<Text size="sm" fw={500}>
				{label}
			</Text>
			<Group align="flex-start" wrap="nowrap">
				<Code block style={{ flex: 1, overflowWrap: 'anywhere' }}>
					{value}
				</Code>
				<CopyButton value={value}>
					{({ copied, copy }) => (
						<Button
							variant="light"
							color={copied ? 'green' : undefined}
							leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
							onClick={copy}
						>
							{copied ? 'Copied' : 'Copy'}
						</Button>
					)}
				</CopyButton>
			</Group>
			<Text size="xs" c="dimmed" span>
				<IconKey size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
				Treat this value as a credential until enrollment completes.
			</Text>
		</Stack>
	)
}
