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
import { IconCheck, IconCopy, IconKey, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import type {
	AuthPasswordSetupInput,
	AuthSetupFailure,
	AuthSetupMutationResult,
	AuthSetupSnapshot,
	AuthTotpEnrollment,
} from '../workbench-contracts.ts'
import {
	authSetupSnapshotQuery,
	beginTotpMutation,
	confirmTotpMutation,
	setupOidcSecretMutation,
	setupPasswordMutation,
	setupScope,
} from './setup.scope.ts'

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

type AuthSetupOperation = 'password' | 'totp-enrollment' | 'totp-confirmation' | 'oidc-secret'

type AuthSetupDraft = {
	username: string
	password: string
	passwordConfirmation: string
	oidcSecret: string
	enrollment: AuthTotpEnrollment | undefined
	totpCode: string
}

function clearDraftSecrets(draft: AuthSetupDraft): boolean {
	const changed =
		draft.password.length > 0 ||
		draft.passwordConfirmation.length > 0 ||
		draft.oidcSecret.length > 0 ||
		draft.enrollment !== undefined ||
		draft.totpCode.length > 0
	draft.password = ''
	draft.passwordConfirmation = ''
	draft.oidcSecret = ''
	draft.enrollment = undefined
	draft.totpCode = ''
	return changed
}

function useAuthSetupDraft() {
	const mounted = useRef(true)
	// JavaScript strings cannot be zeroed, but one mutable owner lets every transition and
	// unmount immediately drop the references retained by this component.
	const draftRef = useRef<AuthSetupDraft>({
		username: '',
		password: '',
		passwordConfirmation: '',
		oidcSecret: '',
		enrollment: undefined,
		totpCode: '',
	})
	const [, rerender] = useReducer((revision: number) => revision + 1, 0)

	const update = useCallback((patch: Partial<AuthSetupDraft>) => {
		Object.assign(draftRef.current, patch)
		rerender()
	}, [])
	const clearSecrets = useCallback(() => {
		if (clearDraftSecrets(draftRef.current)) rerender()
	}, [])

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			clearDraftSecrets(draftRef.current)
		}
	}, [])

	return Object.freeze({ draft: draftRef.current, mounted, update, clearSecrets })
}

function snapshotIdentity(snapshot: AuthSetupSnapshot | undefined): string {
	if (!snapshot) return 'pending'
	// A same-state refresh must preserve an in-progress enrollment.
	return snapshot.state === 'configured'
		? `${snapshot.mode}:configured`
		: `${snapshot.mode}:${snapshot.state}:${snapshot.reason}`
}

function AuthSetup() {
	const { host } = setupScope.useWorkbench()
	const snapshotQuery = authSetupSnapshotQuery.useQuery()
	const setupPassword = setupPasswordMutation.useMutation()
	const beginTotpEnrollment = beginTotpMutation.useMutation()
	const confirmTotpEnrollment = confirmTotpMutation.useMutation()
	const setupOidcSecret = setupOidcSecretMutation.useMutation()
	const { draft, mounted, update: updateDraft, clearSecrets } = useAuthSetupDraft()
	const operationPending = useRef(false)
	const [activeOperation, setActiveOperation] = useState<AuthSetupOperation>()
	const [error, setError] = useState<string>()
	const querySnapshot = snapshotQuery.data
	const latestQuerySnapshot = useRef(querySnapshot)
	latestQuerySnapshot.current = querySnapshot
	const committedAgainst = useRef<AuthSetupSnapshot | undefined>(undefined)
	const [committedSnapshot, setCommittedSnapshot] = useState<AuthSetupSnapshot>()
	const snapshot = committedSnapshot ?? querySnapshot
	const snapshotKey = snapshotIdentity(snapshot)
	const latestSnapshotKey = useRef(snapshotKey)
	latestSnapshotKey.current = snapshotKey
	const loading = snapshotQuery.isPending || snapshotQuery.isFetching
	const busy = loading || activeOperation !== undefined
	const visibleError =
		error ?? (snapshotQuery.status === 'error' ? messageOf(snapshotQuery.error) : undefined)

	useEffect(() => {
		clearSecrets()
	}, [clearSecrets, snapshotKey])

	useEffect(() => {
		if (committedSnapshot && querySnapshot !== committedAgainst.current) {
			// A post-commit query result has arrived; it is authoritative again. Until this
			// point the mutation result prevents the stale setup form from reopening.
			setCommittedSnapshot(undefined)
		}
	}, [committedSnapshot, querySnapshot])

	const refresh = async () => {
		try {
			await snapshotQuery.refetch()
			if (mounted.current) setError(undefined)
		} catch (caught) {
			if (mounted.current) setError(messageOf(caught))
		}
	}

	const runCredentialOperation = async <Result,>(
		name: AuthSetupOperation,
		operation: () => Promise<Result>,
	): Promise<Result | undefined> => {
		if (operationPending.current) return undefined
		operationPending.current = true
		setActiveOperation(name)
		try {
			return await operation()
		} catch (caught) {
			if (mounted.current) setError(messageOf(caught))
			return undefined
		} finally {
			operationPending.current = false
			if (mounted.current) setActiveOperation(undefined)
		}
	}

	const applyMutationFailure = (failure: AuthSetupFailure): void => {
		if (!mounted.current) return
		if (failure.code === 'not_required') {
			setError(undefined)
			clearSecrets()
		} else if (failure.code === 'enrollment_expired') {
			setError(failure.message)
			clearSecrets()
		} else {
			setError(failure.message)
		}
	}

	const applyMutationResult = (result: AuthSetupMutationResult): void => {
		if (!mounted.current) return
		if (result.ok === false) {
			applyMutationFailure(result)
			return
		}
		const currentQuerySnapshot = latestQuerySnapshot.current
		if (snapshotIdentity(currentQuerySnapshot) === snapshotIdentity(result.snapshot)) {
			setCommittedSnapshot(undefined)
		} else {
			committedAgainst.current = currentQuerySnapshot
			setCommittedSnapshot(result.snapshot)
		}
		setError(undefined)
		clearSecrets()
	}

	const passwordInput = (): AuthPasswordSetupInput => ({
		username: draft.username,
		password: draft.password,
		passwordConfirmation: draft.passwordConfirmation,
	})

	const submitPassword = async (event: FormEvent) => {
		event.preventDefault()
		const result = await runCredentialOperation('password', () =>
			setupPassword.mutateAsync(passwordInput()),
		)
		if (result) applyMutationResult(result)
	}

	const beginTotp = async (event: FormEvent) => {
		event.preventDefault()
		const operationSnapshotKey = snapshotKey
		const result = await runCredentialOperation('totp-enrollment', async () => {
			try {
				return await beginTotpEnrollment.mutateAsync(passwordInput())
			} finally {
				// Enrollment includes a TOTP secret. Never retain a second copy in mutation state.
				beginTotpEnrollment.reset()
			}
		})
		if (!result || !mounted.current) return
		if (result.ok === false) {
			applyMutationFailure(result)
			return
		}
		if (latestSnapshotKey.current !== operationSnapshotKey) {
			clearSecrets()
			return
		}
		updateDraft({
			password: '',
			passwordConfirmation: '',
			oidcSecret: '',
			enrollment: result.enrollment,
			totpCode: '',
		})
		setError(undefined)
	}

	const confirmTotp = async (event: FormEvent) => {
		event.preventDefault()
		if (!draft.enrollment) return
		const result = await runCredentialOperation('totp-confirmation', () =>
			confirmTotpEnrollment.mutateAsync({
				enrollmentId: draft.enrollment!.id,
				code: draft.totpCode,
			}),
		)
		if (result) applyMutationResult(result)
	}

	const submitOidcSecret = async (event: FormEvent) => {
		event.preventDefault()
		const result = await runCredentialOperation('oidc-secret', () =>
			setupOidcSecret.mutateAsync({ secret: draft.oidcSecret }),
		)
		if (result) applyMutationResult(result)
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

				{visibleError ? <Alert color="red">{visibleError}</Alert> : null}

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
						username={draft.username}
						password={draft.password}
						passwordConfirmation={draft.passwordConfirmation}
						busy={busy}
						onUsername={(username) => updateDraft({ username })}
						onPassword={(password) => updateDraft({ password })}
						onPasswordConfirmation={(passwordConfirmation) => updateDraft({ passwordConfirmation })}
						onSubmit={(event) => void submitPassword(event)}
					/>
				) : null}

				{snapshot?.state === 'setup-required' && snapshot.mode === 'password-totp' ? (
					draft.enrollment ? (
						<Card withBorder>
							<form onSubmit={(event) => void confirmTotp(event)}>
								<Stack gap="md">
									<Stack gap={4}>
										<Text fw={600}>Enroll a TOTP authenticator</Text>
										<Text size="sm" c="dimmed">
											Add the secret to your authenticator, then enter its current six-digit code.
										</Text>
									</Stack>
									<SecretValue label="Base32 secret" value={draft.enrollment.secret} />
									<SecretValue label="Provisioning URI" value={draft.enrollment.provisioningUri} />
									<Text size="xs" c="dimmed">
										Enrollment expires at {new Date(draft.enrollment.expiresAt).toLocaleString()}.
									</Text>
									<TextInput
										label="One-time code"
										inputMode="numeric"
										maxLength={6}
										value={draft.totpCode}
										disabled={busy}
										onChange={(event) =>
											updateDraft({
												totpCode: event.currentTarget.value.replaceAll(/\D/g, '').slice(0, 6),
											})
										}
									/>
									<Group>
										<Button
											type="submit"
											loading={activeOperation === 'totp-confirmation'}
											disabled={busy || draft.totpCode.length !== 6}
										>
											Confirm and save
										</Button>
										<Button
											type="button"
											variant="subtle"
											disabled={busy}
											onClick={() => {
												clearSecrets()
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
							username={draft.username}
							password={draft.password}
							passwordConfirmation={draft.passwordConfirmation}
							busy={busy}
							submitLabel="Continue to TOTP"
							onUsername={(username) => updateDraft({ username })}
							onPassword={(password) => updateDraft({ password })}
							onPasswordConfirmation={(passwordConfirmation) =>
								updateDraft({ passwordConfirmation })
							}
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
									value={draft.oidcSecret}
									disabled={busy}
									onChange={(event) => updateDraft({ oidcSecret: event.currentTarget.value })}
								/>
								<Button
									type="submit"
									loading={activeOperation === 'oidc-secret'}
									disabled={busy || draft.oidcSecret.length === 0}
								>
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

export default setupScope.render(AuthSetup)

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
