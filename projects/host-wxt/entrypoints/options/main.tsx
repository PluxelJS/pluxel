import '@mantine/core/styles.css'
import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	MantineProvider,
	Stack,
	Switch,
	Title,
} from '@mantine/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { catalogUpdates, close } from '../../src/application'
import { watchConfig } from '../../src/config-storage'
import { resetPreferences, setPreference, watchPreferences } from '../../src/preferences'
import { ConfigEditor } from './ConfigEditor'
import { readRules, type RuleView } from './management'
import './style.css'
import icon from '../../assets/icon.svg'

function Options() {
	const [rules, setRules] = useState<RuleView[]>([])
	const [issue, setIssue] = useState('')
	const [hotIssue, setHotIssue] = useState('')
	const [busy, setBusy] = useState(false)
	const request = useRef(0)
	const refresh = useCallback(async () => {
		const latest = ++request.current
		try {
			const snapshot = await readRules()
			if (latest === request.current) {
				setRules(snapshot)
				setIssue('')
			}
		} catch (error) {
			if (latest === request.current) setIssue(String(error))
		}
	}, [])
	useEffect(() => {
		const unwatch = watchPreferences(() => void refresh())
		const unwatchConfig = watchConfig(() => void refresh())
		const update = (event: Event) => {
			setHotIssue(event instanceof CustomEvent ? event.detail : '')
			void refresh()
		}
		catalogUpdates.addEventListener('updated', update)
		void refresh()
		return () => {
			++request.current
			unwatch()
			unwatchConfig()
			catalogUpdates.removeEventListener('updated', update)
		}
	}, [refresh])
	async function write(operation: Promise<void>) {
		setBusy(true)
		try {
			await operation
			await refresh()
		} catch (error) {
			setIssue(String(error))
		} finally {
			setBusy(false)
		}
	}

	return (
		<Stack component="main" className="options" gap="lg">
			<Group justify="space-between">
				<Group gap="xs">
					<img src={icon} width="34" height="34" alt="" />
					<Title order={1}>净链规则</Title>
				</Group>
				<Button
					variant="default"
					size="xs"
					disabled={busy}
					onClick={() => void write(resetPreferences())}
				>
					恢复默认启停
				</Button>
			</Group>
			{(issue || hotIssue) && (
				<Alert color="red" role="alert">
					{issue || hotIssue}
				</Alert>
			)}
			{rules.map(({ key, status, form }) => (
				<Card component="section" aria-label={status.displayName} key={key} withBorder>
					<Stack>
						<Group justify="space-between">
							<Title order={2}>{status.displayName}</Title>
							<Switch
								aria-label={status.displayName}
								checked={status.autoStart}
								disabled={busy || Boolean(issue)}
								onChange={(event) => void write(setPreference(key, event.currentTarget.checked))}
							/>
						</Group>
						<Badge color={status.lifecycleState === 'running' ? 'teal' : 'gray'}>
							{status.lifecycleState === 'running' ? '已启用' : '已停用'}
						</Badge>
						{status.issues.map((problem) => (
							<Alert key={problem.id} color="red">
								{problem.message}
							</Alert>
						))}
						{form && <ConfigEditor ruleKey={key} model={form} refresh={refresh} />}
					</Stack>
				</Card>
			))}
		</Stack>
	)
}
const root = createRoot(document.getElementById('app')!)
root.render(
	<MantineProvider theme={{ primaryColor: 'teal' }} defaultColorScheme="auto">
		<Options />
	</MantineProvider>,
)
window.addEventListener(
	'pagehide',
	() => {
		root.unmount()
		void close().catch(console.error)
	},
	{ once: true },
)
