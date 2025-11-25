import {
	Accordion,
	Box,
	Button,
	Card,
	Group,
	ScrollArea,
	Stack,
	Tabs,
	Text,
	Title,
} from '@mantine/core'
import { useState } from 'react'
import { AutoForm } from '../index'
import { AUTOFORM_CASES } from './cases'

export function Home() {
	const cases = AUTOFORM_CASES
	const [activeId, setActiveId] = useState(cases[0]?.id ?? '')

	return (
		<Tabs value={activeId} onChange={(value) => value && setActiveId(value)} keepMounted={false}>
			<Tabs.List>
				{cases.map((item) => (
					<Tabs.Tab value={item.id} key={item.id}>
						{item.label}
					</Tabs.Tab>
				))}
			</Tabs.List>

			{cases.map((item) => (
				<Tabs.Panel value={item.id} key={item.id}>
					<DemoCase demo={item} />
				</Tabs.Panel>
			))}
		</Tabs>
	)
}

function DemoCase({ demo }: { demo: (typeof AUTOFORM_CASES)[number] }) {
	const { description, schema, formOpts, id } = demo

	return (
		<Stack gap="md" style={{ minHeight: 'calc(100vh - 120px)', paddingTop: 16 }}>
			{/* Description */}
			{description ? (
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			) : null}

			{/* Schema Viewer */}
			<Accordion variant="contained" chevronPosition="left">
				<Accordion.Item value="schema">
					<Accordion.Control>
						<Text size="sm" fw={500}>
							查看 Schema 定义
						</Text>
					</Accordion.Control>
					<Accordion.Panel>
						<ScrollArea h={300} offsetScrollbars type="auto">
							<pre
								style={{
									fontSize: '12px',
									margin: 0,
									padding: '12px',
									backgroundColor: 'var(--mantine-color-gray-0)',
									borderRadius: '4px',
									overflow: 'auto',
								}}
							>
								<code>{JSON.stringify(schema, null, 2)}</code>
							</pre>
						</ScrollArea>
					</Accordion.Panel>
				</Accordion.Item>
			</Accordion>

			<AutoForm key={id} schema={schema as any} formOpts={formOpts}>
				<AutoForm.Actions>
					{({ submit, reset, dirty, canSubmit, submitting }) => (
						<Group gap="sm" justify="flex-end">
							<Button
								variant="default"
								onClick={() => reset()}
								disabled={!dirty || submitting}
								type="button"
							>
								取消
							</Button>
							<Button
								onClick={() => submit()}
								disabled={!canSubmit}
								loading={submitting}
								type="button"
							>
								{submitting ? '提交中…' : '提交'}
							</Button>
						</Group>
					)}
				</AutoForm.Actions>

				<ScrollArea style={{ flex: 1, minHeight: 0 }} offsetScrollbars type="hover">
					<Box px="sm" pb={96 /* 留出悬浮操作区的高度余量 */}>
						<AutoForm.Fields />
					</Box>
				</ScrollArea>

				{/* Enhanced Debug Panel */}
				<Card withBorder style={{ marginTop: 16 }}>
					<Stack gap="xs">
						<Title order={5} size="sm" c="dimmed">
							调试信息
						</Title>
						<AutoForm.DebugPanel />
					</Stack>
				</Card>
			</AutoForm>
		</Stack>
	)
}
