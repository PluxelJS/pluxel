import { Card, Group, ScrollArea, Stack, Tabs, Text } from '@mantine/core'
import { useEffect, useMemo, useState } from 'react'
import { AutoForm } from '../../index'
import { SchemaPreview } from './SchemaPreview'
import { PlaygroundPanel, type PlaygroundState } from './PlaygroundPanel'
import { SnapshotPanel } from './SnapshotPanel'

export interface UtilityPanelProps {
	schemaSource?: string
	playground: PlaygroundState
	activeTab?: string | null
	onTabChange?: (value: string | null) => void
	onPlaygroundCodeChange: (value: string) => void
	onPlaygroundRun: () => void
	onPlaygroundReset: () => void
	onPlaygroundToggleEnabled: (next: boolean) => void
}

export function UtilityPanel({
	schemaSource,
	playground,
	activeTab,
	onTabChange,
	onPlaygroundCodeChange,
	onPlaygroundRun,
	onPlaygroundReset,
	onPlaygroundToggleEnabled,
}: UtilityPanelProps) {
	const tabs = useMemo(
		() => [
			{ value: 'debug', label: 'Debug' },
			{ value: 'snapshot', label: 'Snapshot' },
			{ value: 'schema', label: 'Schema' },
			{ value: 'playground', label: 'Playground' },
		],
		[],
	)

	const [internalTab, setInternalTab] = useState(tabs[0]?.value ?? null)
	const tabValue = activeTab ?? internalTab
	const handleTabChange = (value: string | null) => {
		if (activeTab !== undefined) {
			onTabChange?.(value)
		} else {
			setInternalTab(value)
		}
	}

	useEffect(() => {
		if (tabs.length === 0) {
			if (activeTab !== undefined) {
				onTabChange?.(null)
			} else {
				setInternalTab(null)
			}
			return
		}
		if (!tabValue || !tabs.some((tab) => tab.value === tabValue)) {
			if (activeTab !== undefined) {
				onTabChange?.(tabs[0].value)
			} else {
				setInternalTab(tabs[0].value)
			}
		}
	}, [tabs, tabValue, activeTab, onTabChange])

	return (
		<Card
			withBorder
			style={{ minWidth: 320, height: '100%', display: 'flex', flexDirection: 'column' }}
		>
			<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
				<Group justify="space-between" align="center">
					<Text fw={600}>辅助面板</Text>
				</Group>
				<Tabs
					value={tabValue}
					onChange={handleTabChange}
					style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
				>
					<Tabs.List>
						{tabs.map((tab) => (
							<Tabs.Tab key={tab.value} value={tab.value}>
								{tab.label}
							</Tabs.Tab>
						))}
					</Tabs.List>
					<Tabs.Panel value="schema" pt="sm" style={{ flex: 1, minHeight: 0 }}>
						<ScrollArea style={{ height: '100%' }} offsetScrollbars type="auto">
							<SchemaPreview sourceText={schemaSource} />
						</ScrollArea>
					</Tabs.Panel>
					<Tabs.Panel value="debug" pt="sm" style={{ flex: 1, minHeight: 0 }}>
						<ScrollArea style={{ height: '100%' }} offsetScrollbars type="auto">
							<Stack gap="xs" pb="sm">
								<AutoForm.DebugPanel />
							</Stack>
						</ScrollArea>
					</Tabs.Panel>
					<Tabs.Panel value="snapshot" pt="sm" style={{ flex: 1, minHeight: 0 }}>
						<ScrollArea style={{ height: '100%' }} offsetScrollbars type="auto">
							<SnapshotPanel />
						</ScrollArea>
					</Tabs.Panel>
					<Tabs.Panel value="playground" pt="sm" style={{ flex: 1, minHeight: 0 }}>
						<ScrollArea style={{ height: '100%' }} offsetScrollbars type="auto">
							<PlaygroundPanel
								state={playground}
								onCodeChange={onPlaygroundCodeChange}
								onRun={onPlaygroundRun}
								onReset={onPlaygroundReset}
								onToggleEnabled={onPlaygroundToggleEnabled}
							/>
						</ScrollArea>
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</Card>
	)
}
