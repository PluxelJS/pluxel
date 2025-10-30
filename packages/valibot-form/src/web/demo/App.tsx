import { Box, Button, Group, ScrollArea, Stack, Tabs, Text } from '@mantine/core'
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
			{description ? (
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			) : null}

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

				<AutoForm.DebugPanel />
			</AutoForm>
		</Stack>
	)
}
