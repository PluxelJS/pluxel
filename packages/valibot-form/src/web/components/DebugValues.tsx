// DebugValues.tsx
import { Tabs, ScrollArea } from '@mantine/core'

export function DebugValues({ formValues }: { formValues: any }) {
	const { values, errorMap, errors } = formValues

	return (
		<Tabs defaultValue="values" variant="pills">
			<Tabs.List mb="xs">
				<Tabs.Tab value="values">表单值</Tabs.Tab>
				<Tabs.Tab value="errors">错误信息</Tabs.Tab>
			</Tabs.List>

			<Tabs.Panel value="values">
				<ScrollArea h={200} offsetScrollbars type="auto">
					<pre
						style={{
							fontSize: '12px',
							margin: 0,
							padding: '8px',
							backgroundColor: 'var(--mantine-color-gray-0)',
							borderRadius: '4px',
						}}
					>
						<code>{JSON.stringify(values, null, 2)}</code>
					</pre>
				</ScrollArea>
			</Tabs.Panel>

			<Tabs.Panel value="errors">
				<ScrollArea h={200} offsetScrollbars type="auto">
					<pre
						style={{
							fontSize: '12px',
							margin: 0,
							padding: '8px',
							backgroundColor: 'var(--mantine-color-gray-0)',
							borderRadius: '4px',
						}}
					>
						<code>
							{JSON.stringify(
								{
									errorMap,
									errors,
								},
								null,
								2,
							)}
						</code>
					</pre>
				</ScrollArea>
			</Tabs.Panel>
		</Tabs>
	)
}
