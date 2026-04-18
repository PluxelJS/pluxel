import {
	ActionIcon,
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Paper,
	SegmentedControl,
	Stack,
	Table,
	Text,
	TextInput,
	Textarea,
	Title,
} from '@mantine/core'
import { startRegistration } from '@simplewebauthn/browser'
import { IconRefresh, IconShieldLock, IconTrash } from '@tabler/icons-react'
import { useEffect, useEffectEvent, useState } from 'react'
import {
	getRuntimeSecurityClient,
	type SecurityAuditEvent,
	type SecurityOverview,
	type VaultAdminState,
	type VaultKeyPair,
	rpcErrorMessage,
} from '../../runtime'
import { EmptyState, ErrorState } from '../../components'
import { useNotify } from '../hooks'

type OtpEnrollmentState = {
	username: string
	secret: string
	otpauthUrl: string
} | null

type RefreshOptions = {
	syncDeployRecipientsDraft?: boolean
	clearOtpEnrollment?: boolean
}

const eventTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'short',
	timeStyle: 'short',
})

const pageGridStyle = {
	display: 'grid',
	gap: 12,
	gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
	alignItems: 'start',
}

const summaryGridStyle = {
	display: 'grid',
	gap: 10,
	gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
}

const summaryCardStyle = {
	padding: '10px 12px',
	border: '1px solid var(--mantine-color-default-border)',
	borderRadius: 'var(--mantine-radius-sm)',
	background: 'var(--mantine-color-body)',
}

const rowStyle = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'flex-start',
	gap: 10,
	padding: '10px 12px',
	border: '1px solid var(--mantine-color-default-border)',
	borderRadius: 'var(--mantine-radius-sm)',
}

const formGridStyle = {
	display: 'grid',
	gap: 10,
}

function toneForReason(reason?: string): string {
	switch (reason) {
		case 'bypass':
			return 'gray'
		case 'misconfigured':
			return 'red'
		case 'verification_required':
			return 'orange'
		case 'unlock_required':
			return 'blue'
		default:
			return 'gray'
	}
}

function labelForVerificationMode(mode: SecurityOverview['verification']['mode']): string {
	return mode === 'enforce' ? '已启用' : '未启用'
}

function labelForVerificationMethod(method: SecurityOverview['verification']['method']): string {
	switch (method) {
		case 'password':
			return '密码'
		case 'otp':
			return 'OTP'
		case 'passkey':
			return 'Passkey'
	}
}

function labelForVerificationState(verification: SecurityOverview['verification']): string {
	if (verification.mode === 'bypass') return '未启用'
	if (verification.allow) return '已验证'
	switch (verification.reason) {
		case 'misconfigured':
			return '待配置'
		case 'verification_required':
			return '待验证'
		default:
			return '受限'
	}
}

function labelForVaultState(vault: VaultAdminState): string {
	if (vault.lastError) return '异常'
	if (vault.unlocked) return '已解锁'
	if (!vault.present) return '空挂载'
	return '已封存'
}

function labelForUnlockSource(source: VaultAdminState['unlockedBy']): string {
	if (source === 'host') return '本机'
	if (source === 'deploy') return '部署环境'
	return '-'
}

function labelForVaultReason(reason?: VaultAdminState['reason']): string {
	if (reason === 'unlock_required') return '需要解锁'
	return '-'
}

function toneForEventStatus(status: SecurityAuditEvent['status']): string {
	switch (status) {
		case 'success':
			return 'green'
		case 'failure':
			return 'red'
		default:
			return 'blue'
	}
}

function summarizeInventory(vault: VaultAdminState) {
	const namespaces = vault.namespaces ?? []
	return namespaces.reduce(
		(acc, row) => {
			acc.namespaces += 1
			acc.kv += row.kvKeys
			acc.docs += row.docDocuments
			acc.blobs += row.blobs
			return acc
		},
		{ namespaces: 0, kv: 0, docs: 0, blobs: 0 },
	)
}

function vaultHeadline(vault: VaultAdminState): { label: string; color: string } {
	if (vault.lastError) return { label: 'error', color: 'red' }
	if (vault.unlocked) return { label: 'unlocked', color: 'green' }
	if (!vault.present) return { label: 'empty', color: 'gray' }
	return { label: 'sealed', color: 'blue' }
}

function parseRecipientsDraft(input: string): string[] {
	const seen = new Set<string>()
	const recipients: string[] = []
	for (const line of input.split('\n')) {
		const recipient = line.trim()
		if (!recipient || seen.has(recipient)) continue
		seen.add(recipient)
		recipients.push(recipient)
	}
	return recipients
}

function formatRecipientsDraft(input: string[]): string {
	return input.join('\n')
}

function verificationActionLabel(method: SecurityOverview['verification']['method']): string {
	switch (method) {
		case 'password':
			return '添加密码账户'
		case 'otp':
			return '添加 OTP 账户'
		case 'passkey':
			return '添加 Passkey'
	}
}

function verificationMethodHint(method: SecurityOverview['verification']['method']): string {
	switch (method) {
		case 'password':
			return '重复用户名会直接更新密码。'
		case 'otp':
			return '每次生成都会刷新这个账户的 OTP 密钥。'
		case 'passkey':
			return 'Passkey 会直接绑定到当前账户。'
	}
}

export function SecurityScreen() {
	const notify = useNotify()
	const security = getRuntimeSecurityClient()
	const verificationApi = security.verification
	const vaultApi = security.vault
	const [overview, setOverview] = useState<SecurityOverview | null>(null)
	const [events, setEvents] = useState<SecurityAuditEvent[]>([])
	const [loading, setLoading] = useState(true)
	const [refreshing, setRefreshing] = useState(false)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [hostRecipient, setHostRecipient] = useState<string | null>(null)
	const [verificationUsernameDraft, setVerificationUsernameDraft] = useState('')
	const [verificationPasswordDraft, setVerificationPasswordDraft] = useState('')
	const [verificationOtpEnrollment, setVerificationOtpEnrollment] = useState<OtpEnrollmentState>(null)
	const [deployRecipientsDraft, setDeployRecipientsDraft] = useState('')
	const [generatedKeyPair, setGeneratedKeyPair] = useState<VaultKeyPair | null>(null)
	const verification = overview?.verification ?? null
	const vault = overview?.vault ?? null

	function applyOverview(nextOverview: SecurityOverview, options: RefreshOptions = {}) {
		setOverview(nextOverview)
		if (options.clearOtpEnrollment) {
			setVerificationOtpEnrollment(null)
		}
		if (options.syncDeployRecipientsDraft) {
			setDeployRecipientsDraft(formatRecipientsDraft(nextOverview.vault.deploy.recipients))
		}
	}

	const refresh = useEffectEvent(async (options: RefreshOptions = {}) => {
		setRefreshing(true)
		setError(null)
		try {
			const [nextOverview, nextEvents] = await Promise.all([
				security.readOverview(),
				security.listEvents(),
			])
			applyOverview(nextOverview, options)
			setEvents(nextEvents)
		} catch (cause) {
			setError(rpcErrorMessage(cause, '无法加载 security 数据'))
		} finally {
			setLoading(false)
			setRefreshing(false)
		}
	})

	useEffect(() => {
		void refresh({
			syncDeployRecipientsDraft: true,
			clearOtpEnrollment: true,
		})
	}, [])

	async function setVerificationMode(mode: SecurityOverview['verification']['mode']) {
		if (!verification || mode === verification.mode) return
		setBusy('verification-mode')
		try {
			await verificationApi.setMode(mode)
			await refresh()
			notify({
				color: 'green',
				message: `访问模式已切换为${labelForVerificationMode(mode)}`,
			})
		} catch (cause) {
			notify({
				color: 'red',
				message: rpcErrorMessage(cause, '更新 verification gate 失败'),
			})
		} finally {
			setBusy(null)
		}
	}

	async function setVerificationMethod(method: SecurityOverview['verification']['method']) {
		if (!verification || method === verification.method) return
		if (
			typeof window !== 'undefined' &&
			!window.confirm('切换验证方式会清空现有账户，继续吗？')
		) {
			return
		}
		setBusy('verification-method')
		try {
			await verificationApi.setMethod(method)
			setVerificationUsernameDraft('')
			setVerificationPasswordDraft('')
			setVerificationOtpEnrollment(null)
			await refresh({ clearOtpEnrollment: true })
			notify({
				color: 'green',
				message: `验证方式已切换为${labelForVerificationMethod(method)}`,
			})
		} catch (cause) {
			notify({
				color: 'red',
				message: rpcErrorMessage(cause, '更新 verification method 失败'),
			})
		} finally {
			setBusy(null)
		}
	}

	function clearVerificationDrafts() {
		setVerificationUsernameDraft('')
		setVerificationPasswordDraft('')
	}

	async function submitVerificationUser() {
		if (!verification) return
		const username = verificationUsernameDraft.trim()
		if (!username) {
				notify({
					color: 'red',
					message: '请输入用户名',
				})
			return
		}

		if (verification.method === 'password') {
			setBusy('verification-user-password')
			try {
				const password = verificationPasswordDraft
				if (password.trim().length === 0) {
						notify({
							color: 'red',
							message: '请输入密码',
						})
					return
				}
				await verificationApi.upsertPasswordUser({ username, password })
				clearVerificationDrafts()
				await refresh()
				notify({
					color: 'green',
					message: `已保存密码账户 ${username}`,
				})
			} catch (cause) {
				notify({
					color: 'red',
					message: rpcErrorMessage(cause, '保存密码账户失败'),
				})
			} finally {
				setBusy(null)
			}
			return
		}

		if (verification.method === 'otp') {
			setBusy('verification-user-otp')
			try {
				const result = await verificationApi.provisionOtpUser({ username })
				setVerificationUsernameDraft('')
				setVerificationOtpEnrollment(result.enrollment)
				await refresh()
				notify({
					color: 'green',
					message: `已为 ${username} 生成新的 OTP 密钥`,
				})
			} catch (cause) {
				notify({
					color: 'red',
					message: rpcErrorMessage(cause, '生成 OTP 密钥失败'),
				})
			} finally {
				setBusy(null)
			}
			return
		}

		setBusy('verification-user-passkey')
		try {
			if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
				throw new Error('Passkey 需要安全浏览器上下文。')
			}
			const options = await verificationApi.beginPasskeyRegistration({ username })
			const credential = await startRegistration({ optionsJSON: options })
			await verificationApi.finishPasskeyRegistration({
				username,
				credential,
			})
			setVerificationUsernameDraft('')
			await refresh()
			notify({
				color: 'green',
				message: `已为 ${username} 注册 Passkey`,
			})
		} catch (cause) {
			notify({
				color: 'red',
				message: rpcErrorMessage(cause, '注册 passkey 失败'),
			})
		} finally {
			setBusy(null)
		}
	}

	async function deleteVerificationUser(username: string) {
		setBusy(`verification-user-delete:${username}`)
		try {
			await verificationApi.deleteUser({ username })
			await refresh()
			notify({
				color: 'green',
				message: `已删除账户 ${username}`,
			})
		} catch (cause) {
				notify({
					color: 'red',
					message: rpcErrorMessage(cause, '删除账户失败'),
				})
		} finally {
			setBusy(null)
		}
	}

	async function unlockVault() {
		setBusy('vault-unlock')
		try {
			await vaultApi.unlock()
			await refresh()
			notify({
				color: 'green',
				message: '已完成解锁检查',
			})
		} catch (cause) {
				notify({
					color: 'red',
					message: rpcErrorMessage(cause, '存储解锁失败'),
				})
		} finally {
			setBusy(null)
		}
	}

	async function ensureHostKey() {
		setBusy('vault-host-key')
		try {
			const result = await vaultApi.ensureHostKey()
			setHostRecipient(result.publicKey)
			await refresh()
			notify({
				color: 'green',
				message: '已准备本机公钥',
			})
		} catch (cause) {
			notify({
				color: 'red',
				message: rpcErrorMessage(cause, '准备 host vault 公钥失败'),
			})
		} finally {
			setBusy(null)
		}
	}

	async function generateKeyPair() {
		setBusy('vault-generate-deploy-key')
		try {
			const result = await vaultApi.generateDeployKey()
			setGeneratedKeyPair(result)
			setDeployRecipientsDraft((current) =>
				formatRecipientsDraft([...parseRecipientsDraft(current), result.publicKey]),
			)
			notify({
				color: 'green',
				message: '已生成部署密钥，并加入接收方草稿',
			})
		} catch (cause) {
			notify({
				color: 'red',
				message: rpcErrorMessage(cause, '生成 deploy keypair 失败'),
			})
		} finally {
			setBusy(null)
		}
	}

	async function saveDeployRecipients() {
		setBusy('vault-deploy-recipients')
		try {
			const publicKeys = parseRecipientsDraft(deployRecipientsDraft)
			await vaultApi.setDeployRecipients(publicKeys)
			await refresh({ syncDeployRecipientsDraft: true })
			notify({
				color: 'green',
				message: publicKeys.length > 0 ? '已更新部署接收方列表' : '已清空部署接收方列表',
			})
		} catch (cause) {
			notify({
				color: 'red',
				message: rpcErrorMessage(cause, '更新 deploy 公钥列表失败'),
			})
		} finally {
			setBusy(null)
		}
	}

	if (loading) {
		return (
			<Stack align="center" justify="center" style={{ flex: 1, minHeight: 320 }}>
				<Loader color="brand" />
				<Text c="dimmed">正在读取宿主安全状态…</Text>
			</Stack>
		)
	}

	if (error && !overview) {
		return <ErrorState title="无法加载安全页面" message={error} minHeight={320} />
	}

	if (!verification || !vault) {
		return (
			<EmptyState
				title="安全状态不可用"
				description="当前宿主没有返回 verification 或 vault 管理快照。"
				minHeight={320}
				withBorder
				icon={<IconShieldLock size={24} />}
			/>
		)
	}

	const inventorySummary = summarizeInventory(vault)
	const visibleInventory = (vault.namespaces ?? []).slice(0, 5)
	const recentEvents = events.slice(0, 6)
	const vaultState = vaultHeadline(vault)
	const verificationUsers = verification.users
	const verificationEnabled = verification.mode === 'enforce'
	const passkeyReadyInBrowser =
		typeof window !== 'undefined' &&
		window.isSecureContext &&
		typeof window.PublicKeyCredential !== 'undefined' &&
		typeof navigator !== 'undefined' &&
		!!navigator.credentials
	const normalizedRecipientsDraft = formatRecipientsDraft(parseRecipientsDraft(deployRecipientsDraft))
	const currentRecipients = formatRecipientsDraft(vault.deploy.recipients)
	const deployRecipientsDirty = normalizedRecipientsDraft !== currentRecipients
	const verificationSubmitBusy =
		busy === 'verification-user-password' ||
		busy === 'verification-user-otp' ||
		busy === 'verification-user-passkey'
	const verificationSubmitDisabled =
		verificationSubmitBusy ||
		verificationUsernameDraft.trim().length === 0 ||
		(verification.method === 'password' && verificationPasswordDraft.trim().length === 0) ||
		(verification.method === 'passkey' && !passkeyReadyInBrowser)

	return (
		<Stack gap="sm" style={{ padding: 12 }}>
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Stack gap="sm">
					<Group justify="space-between" align="flex-start">
						<Stack gap={2}>
							<Title order={2}>安全</Title>
							<Text size="sm" c="dimmed">
								默认不启用访问验证。只有在这里主动开启后，控制面才会要求先验证。
							</Text>
						</Stack>
						<Group gap="xs">
							{error ? (
								<Badge color="red" variant="light">
									{error}
								</Badge>
							) : null}
							<ActionIcon
								variant="light"
								color="brand"
								onClick={() => void refresh()}
								loading={refreshing}
								aria-label="刷新 security 状态"
							>
								<IconRefresh size={16} />
							</ActionIcon>
						</Group>
					</Group>

					<div style={summaryGridStyle}>
						<div style={summaryCardStyle}>
							<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
								访问验证
							</Text>
							<Group gap={6} mt={6}>
								<Badge variant="light" color={verificationEnabled ? 'blue' : 'gray'}>
									{labelForVerificationMode(verification.mode)}
								</Badge>
								<Badge
									variant="light"
									color={verificationEnabled && verification.allow ? 'green' : toneForReason(verification.reason)}
								>
									{labelForVerificationState(verification)}
								</Badge>
								{verificationEnabled ? (
									<Badge variant="light" color="grape">
										{labelForVerificationMethod(verification.method)}
									</Badge>
								) : null}
							</Group>
							<Text size="sm" mt={8}>
								{verificationEnabled
									? `${verificationUsers.length} 个账户`
									: '当前 host 进入控制面不需要验证'}
							</Text>
						</div>

						<div style={summaryCardStyle}>
							<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
								加密存储
							</Text>
							<Group gap={6} mt={6}>
								<Badge variant="light" color={vaultState.color}>
									{labelForVaultState(vault)}
								</Badge>
								<Badge variant="light" color={vault.present ? 'blue' : 'gray'}>
									{vault.present ? '挂载已存在' : '挂载未创建'}
								</Badge>
								{vault.unlockedBy ? (
									<Badge variant="light" color={vault.unlockedBy === 'deploy' ? 'teal' : 'green'}>
										{labelForUnlockSource(vault.unlockedBy)}
									</Badge>
								) : null}
							</Group>
							<Text size="sm" mt={8}>
								{inventorySummary.namespaces} 个命名空间 · {inventorySummary.kv} KV · {inventorySummary.docs} 文档 ·{' '}
								{inventorySummary.blobs} 二进制文件
							</Text>
						</div>

						<div style={summaryCardStyle}>
							<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
								解锁材料
							</Text>
							<Group gap={6} mt={6}>
								<Badge variant="light" color={vault.hostIdentityPresent ? 'green' : 'gray'}>
									{vault.hostIdentityPresent ? '本机公钥已就绪' : '本机公钥缺失'}
								</Badge>
								<Badge variant="light" color={vault.deploy.identityPresent ? 'teal' : 'gray'}>
									{vault.deploy.identityPresent ? '环境私钥已注入' : '环境私钥缺失'}
								</Badge>
								<Badge variant="light" color={vault.deploy.recipients.length > 0 ? 'teal' : 'gray'}>
									{vault.deploy.recipients.length} 个接收方
								</Badge>
							</Group>
							<Text size="sm" mt={8}>只看材料是否足够解锁，不绑定访问验证。</Text>
						</div>
					</div>
				</Stack>
			</Paper>

			<div style={pageGridStyle}>
				<Stack gap="sm">
					<Paper withBorder radius="md" p="sm" shadow="xs">
						<Stack gap="sm">
							<Stack gap={0}>
								<Text fw={700}>1. 访问验证</Text>
								<Text size="xs" c="dimmed">
									默认关闭。只有启用后，才需要选择方式并维护账户。
								</Text>
							</Stack>

							<div style={rowStyle}>
								<Stack gap={2}>
									<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
										访问模式
									</Text>
									<Text size="sm">关闭时直接进入控制面，开启后才会拦截。</Text>
								</Stack>
								<SegmentedControl
									size="xs"
									value={verification.mode}
									onChange={(value) => void setVerificationMode(value as typeof verification.mode)}
									disabled={busy === 'verification-mode'}
									data={[
										{ value: 'bypass', label: '关闭' },
										{ value: 'enforce', label: '开启' },
									]}
								/>
							</div>

							{verificationEnabled ? (
								<>
									<div style={rowStyle}>
										<Stack gap={2}>
											<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
												验证方式
											</Text>
											<Text size="sm">切换后会清空现有账户，避免旧材料继续生效。</Text>
										</Stack>
										<SegmentedControl
											size="xs"
											value={verification.method}
											onChange={(value) =>
												void setVerificationMethod(value as typeof verification.method)
											}
											disabled={busy === 'verification-method'}
											data={[
												{ value: 'password', label: '密码' },
												{ value: 'otp', label: 'OTP' },
												{ value: 'passkey', label: 'Passkey' },
											]}
										/>
									</div>

									<Divider />

									<form
										onSubmit={(event) => {
											event.preventDefault()
											void submitVerificationUser()
										}}
									>
										<Stack gap="sm">
											<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
												账户
											</Text>

											<div style={formGridStyle}>
												<TextInput
													label="用户名"
													value={verificationUsernameDraft}
													onChange={(event) =>
														setVerificationUsernameDraft(event.currentTarget.value)
													}
													placeholder="ops"
													size="sm"
												/>

												{verification.method === 'password' ? (
													<TextInput
														label="密码"
														value={verificationPasswordDraft}
														onChange={(event) =>
															setVerificationPasswordDraft(event.currentTarget.value)
														}
														type="password"
														placeholder="secret"
														size="sm"
													/>
												) : null}
											</div>

											<Group justify="space-between" align="flex-start">
												<Text size="xs" c="dimmed" style={{ maxWidth: 460 }}>
													{verificationMethodHint(verification.method)}
													{verification.method === 'passkey'
														? passkeyReadyInBrowser
															? ' 当前浏览器可直接注册。'
															: ' 当前浏览器上下文暂不支持。'
														: ''}
												</Text>
												<Button
													type="submit"
													size="compact-sm"
													loading={verificationSubmitBusy}
													disabled={verificationSubmitDisabled}
												>
													{verificationActionLabel(verification.method)}
												</Button>
											</Group>
										</Stack>
									</form>

									{verificationOtpEnrollment ? (
										<>
											<Divider />
											<Stack gap="xs">
												<Text fw={700} size="sm">
													OTP 配置结果
												</Text>
												<TextInput
													label={`${verificationOtpEnrollment.username} 的 OTP 密钥`}
													value={verificationOtpEnrollment.secret}
													readOnly
													size="xs"
												/>
												<Textarea
													label="OTP 导入地址"
													value={verificationOtpEnrollment.otpauthUrl}
													readOnly
													autosize
													minRows={2}
													size="xs"
												/>
											</Stack>
										</>
									) : null}

									<Divider />

									{verificationUsers.length > 0 ? (
										<Table withTableBorder highlightOnHover>
											<Table.Thead>
												<Table.Tr>
													<Table.Th>用户名</Table.Th>
													<Table.Th>操作</Table.Th>
												</Table.Tr>
											</Table.Thead>
											<Table.Tbody>
												{verificationUsers.map((user) => (
													<Table.Tr key={user.username}>
														<Table.Td>{user.username}</Table.Td>
														<Table.Td>
															<Group justify="flex-end">
																<ActionIcon
																	variant="subtle"
																	color="red"
																	aria-label={`删除 ${user.username}`}
																	onClick={() => void deleteVerificationUser(user.username)}
																	loading={busy === `verification-user-delete:${user.username}`}
																>
																	<IconTrash size={16} />
																</ActionIcon>
															</Group>
														</Table.Td>
													</Table.Tr>
												))}
											</Table.Tbody>
										</Table>
									) : (
										<Text size="sm" c="dimmed">
											开启后还没有可用账户，控制面会停留在待配置状态。
										</Text>
									)}
								</>
							) : (
								<Text size="sm" c="dimmed">
									当前未启用访问验证。需要时再切到“开启”，然后选择方式并添加账户。
								</Text>
							)}
						</Stack>
					</Paper>

					<Paper withBorder radius="md" p="sm" shadow="xs">
						<Stack gap="sm">
							<Group justify="space-between" align="flex-start">
								<Stack gap={0}>
									<Text fw={700}>2. 检查加密存储</Text>
									<Text size="xs" c="dimmed">
										确认挂载是否存在、是否可解锁，以及当前解锁来源。
									</Text>
								</Stack>
								<Button
									size="compact-xs"
									variant="light"
									leftSection={<IconShieldLock size={14} />}
									onClick={() => void unlockVault()}
									loading={busy === 'vault-unlock'}
								>
									尝试解锁
								</Button>
							</Group>

							<Group gap={6}>
								<Badge variant="light" color={vaultState.color}>
									{labelForVaultState(vault)}
								</Badge>
								<Badge variant="light" color={vault.present ? 'blue' : 'gray'}>
									{vault.present ? '挂载已存在' : '挂载未创建'}
								</Badge>
								{vault.unlockedBy ? (
									<Badge variant="light" color={vault.unlockedBy === 'deploy' ? 'teal' : 'green'}>
										{labelForUnlockSource(vault.unlockedBy)}
									</Badge>
								) : null}
								{vault.reason ? (
									<Badge variant="light" color={toneForReason(vault.reason)}>
										{labelForVaultReason(vault.reason)}
									</Badge>
								) : null}
							</Group>

							<div style={rowStyle}>
								<Stack gap={2}>
									<Text size="xs" c="dimmed" tt="uppercase" fw={700}>
										库存概览
									</Text>
									<Text size="sm">
										{inventorySummary.namespaces} 个命名空间 · {inventorySummary.kv} KV · {inventorySummary.docs} 文档 ·{' '}
										{inventorySummary.blobs} 二进制文件
									</Text>
								</Stack>
							</div>

							{vault.lastError ? (
								<div style={rowStyle}>
									<Stack gap={2}>
										<Text fw={600} size="sm" c="red">
											{vault.lastError.code}
										</Text>
										<Text size="sm">{vault.lastError.message}</Text>
									</Stack>
								</div>
							) : null}

							{vault.namespaces ? (
								<Table withTableBorder highlightOnHover>
									<Table.Thead>
										<Table.Tr>
											<Table.Th>命名空间</Table.Th>
											<Table.Th>KV</Table.Th>
											<Table.Th>文档</Table.Th>
											<Table.Th>二进制</Table.Th>
										</Table.Tr>
									</Table.Thead>
									<Table.Tbody>
										{visibleInventory.map((row) => (
											<Table.Tr key={row.namespace}>
												<Table.Td>{row.namespace}</Table.Td>
												<Table.Td>{row.kvKeys}</Table.Td>
												<Table.Td>{row.docDocuments}</Table.Td>
												<Table.Td>{row.blobs}</Table.Td>
											</Table.Tr>
										))}
									</Table.Tbody>
								</Table>
							) : (
								<Text size="sm" c="dimmed">
									未解锁时只展示挂载状态和可用材料。
								</Text>
							)}
						</Stack>
					</Paper>
				</Stack>

				<Stack gap="sm">
					<Paper withBorder radius="md" p="sm" shadow="xs">
						<Stack gap="sm">
							<Stack gap={0}>
								<Text fw={700}>3. 准备解锁材料</Text>
								<Text size="xs" c="dimmed">
									本机公钥用于本地解锁；部署接收方对应环境注入私钥。
								</Text>
							</Stack>

							<Group gap={6}>
								<Badge variant="light" color={vault.hostIdentityPresent ? 'green' : 'gray'}>
									{vault.hostIdentityPresent ? '本机公钥已就绪' : '本机公钥缺失'}
								</Badge>
								<Badge variant="light" color={vault.deploy.identityPresent ? 'teal' : 'gray'}>
									{vault.deploy.identityPresent ? '环境私钥已注入' : '环境私钥缺失'}
								</Badge>
								<Badge variant="light" color={deployRecipientsDirty ? 'orange' : 'gray'}>
									{deployRecipientsDirty ? '名单待提交' : '名单已同步'}
								</Badge>
							</Group>

							<Group gap={6}>
								<Button
									size="compact-sm"
									variant="light"
									onClick={() => void ensureHostKey()}
									loading={busy === 'vault-host-key'}
								>
									{vault.hostIdentityPresent ? '显示本机公钥' : '创建本机公钥'}
								</Button>
								<Button
									size="compact-sm"
									variant="light"
									onClick={() => void generateKeyPair()}
									loading={busy === 'vault-generate-deploy-key'}
								>
									生成部署密钥并加入草稿
								</Button>
							</Group>

							{hostRecipient ? (
								<TextInput label="本机公钥" value={hostRecipient} readOnly size="xs" />
							) : null}

							<Textarea
								label="部署接收方"
								description={`每行一个公钥；对应私钥放入 ${vault.deploy.env}`}
								value={deployRecipientsDraft}
								onChange={(event) => setDeployRecipientsDraft(event.currentTarget.value)}
								placeholder="age1..."
								autosize
								minRows={5}
								size="xs"
							/>

							<Group gap={6}>
								<Button
									size="compact-sm"
									onClick={() => void saveDeployRecipients()}
									loading={busy === 'vault-deploy-recipients'}
									disabled={!deployRecipientsDirty}
								>
									更新名单
								</Button>
								<Button
									size="compact-sm"
									variant="subtle"
									color="gray"
									onClick={() => setDeployRecipientsDraft(currentRecipients)}
									disabled={!deployRecipientsDirty}
								>
									恢复已保存
								</Button>
							</Group>

							{vault.deploy.recipients.length > 0 ? (
								<Stack gap="xs">
									<Text fw={700} size="sm">
										当前接收方
									</Text>
									{vault.deploy.recipients.map((recipient) => (
										<TextInput key={recipient} value={recipient} readOnly size="xs" />
									))}
								</Stack>
							) : null}

							{generatedKeyPair ? (
								<>
									<Divider />
									<Stack gap="xs">
										<Text fw={700} size="sm">
											新生成的部署密钥
										</Text>
										<TextInput
											label="公钥"
											value={generatedKeyPair.publicKey}
											readOnly
											size="xs"
										/>
										<Textarea
											label={`私钥，写入 ${generatedKeyPair.envName}`}
											value={generatedKeyPair.privateKey}
											readOnly
											autosize
											minRows={3}
											size="xs"
										/>
									</Stack>
								</>
							) : null}
						</Stack>
					</Paper>

					<Paper withBorder radius="md" p="sm" shadow="xs">
						<Stack gap="sm">
							<Group justify="space-between" align="center">
								<Text fw={700}>最近操作</Text>
								<Badge variant="light" color="gray">
									{events.length}
								</Badge>
							</Group>

							{recentEvents.length > 0 ? (
								recentEvents.map((event) => (
									<div key={event.id} style={rowStyle}>
										<Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
											<Group gap={6}>
												<Text fw={600} size="sm">
													{event.area}.{event.action}
												</Text>
												<Badge
													size="xs"
													variant="light"
													color={toneForEventStatus(event.status)}
												>
													{event.status}
												</Badge>
											</Group>
											<Text size="xs" c="dimmed">
												{eventTimeFormatter.format(event.at)} · {event.mount ?? '-'}
											</Text>
											<Text size="sm">{event.message}</Text>
										</Stack>
									</div>
								))
							) : (
								<Text size="sm" c="dimmed">
									还没有 security audit 事件。
								</Text>
							)}
						</Stack>
					</Paper>
				</Stack>
			</div>
		</Stack>
	)
}
