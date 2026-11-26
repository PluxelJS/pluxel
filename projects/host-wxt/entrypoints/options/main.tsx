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
	Textarea,
	Title,
} from '@mantine/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { applyPreferences, catalogUpdates, cleanLink, close } from '../../src/application'
import { watchConfig } from '../../src/config-storage'
import { resetPreferences, setPreference, watchPreferences } from '../../src/preferences'
import { ConfigEditor } from './ConfigEditor'
import { readRules, type RuleView } from './management'
import './style.css'
import icon from '../../assets/icon.svg'

function RulePreview({ rules }: { rules: RuleView[] }) {
	const [source, setSource] = useState('https://example.org/guide?ref=mail&utm_source=feed#setup')
	const [result, setResult] = useState({ link: '', error: '' })
	useEffect(() => {
		let active = true
		async function preview() {
			try {
				const ready = source.trim() && rules.every((rule) => !rule.failure)
				const cleaned = ready ? await cleanLink(source) : undefined
				if (active) setResult({ link: cleaned?.link ?? '', error: '' })
			} catch (error) {
				if (active)
					setResult({ link: '', error: error instanceof Error ? error.message : String(error) })
			}
		}
		void preview()
		return () => {
			active = false
		}
	}, [source, rules])
	return (
		<Stack gap="xs">
			<Textarea
				label="测试链接"
				autosize
				minRows={1}
				maxRows={4}
				spellCheck={false}
				error={result.error || undefined}
				value={source}
				onChange={(event) => setSource(event.currentTarget.value)}
			/>
			<div className="preview-result">
				<label htmlFor="preview-result">清理结果</label>
				<output id="preview-result">{result.link}</output>
			</div>
		</Stack>
	)
}

function Options() {
	const [rules, setRules] = useState<RuleView[]>([])
	const [issue, setIssue] = useState('')
	const [hotIssue, setHotIssue] = useState('')
	const [busy, setBusy] = useState(false)
	const request = useRef(0)
	const refresh = useCallback(async (switchChanged = false) => {
		const latest = ++request.current
		try {
			if (switchChanged) await applyPreferences()
			const snapshot = await readRules()
			if (latest === request.current) {
				setRules(snapshot)
				setIssue('')
			}
		} catch (error) {
			if (latest === request.current) {
				setRules([])
				setIssue(String(error))
			}
		}
	}, [])
	useEffect(() => {
		const unwatch = watchPreferences(() => void refresh(true))
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
			{rules.length > 0 && !issue && <RulePreview rules={rules} />}
			{rules.map(({ key, enabled, failure, status, form }) => (
				<Card component="section" aria-label={status.displayName} key={key} withBorder>
					<Stack>
						<Group justify="space-between">
							<Title order={2}>{status.displayName}</Title>
							<Switch
								aria-label={status.displayName}
								checked={enabled}
								disabled={busy || Boolean(issue)}
								onChange={(event) => void write(setPreference(key, event.currentTarget.checked))}
							/>
						</Group>
						{failure ? (
							<Alert color="red" role="alert">
								已保存开关。
								{status.lifecycleState === 'running' ? '规则仍在运行。' : '规则尚未运行。'}
								{failure}
							</Alert>
						) : (
							<Badge color={status.lifecycleState === 'running' ? 'teal' : 'gray'}>
								{status.lifecycleState === 'running' ? '已启用' : '已停用'}
							</Badge>
						)}
						{!failure &&
							status.issues.map((problem) => (
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
