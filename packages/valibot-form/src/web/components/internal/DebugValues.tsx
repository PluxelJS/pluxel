// DebugValues.tsx
import { Tabs } from '@mantine/core'

export function DebugValues({ formValues }: { formValues: any }) {
	const { values, errorMap, errors } = formValues

	return (
		<Tabs defaultValue="values" variant="pills">
			<Tabs.List mb="xs">
				<Tabs.Tab value="values">表单值</Tabs.Tab>
				<Tabs.Tab value="errors">错误信息</Tabs.Tab>
			</Tabs.List>

			<Tabs.Panel value="values">
				<pre
					style={{
						fontSize: '12px',
						margin: 0,
						padding: '8px',
						backgroundColor: 'var(--plx-panel-bg-muted, var(--mantine-color-default-hover))',
						border: '1px solid var(--plx-panel-border, var(--mantine-color-default-border))',
						borderRadius: '4px',
						whiteSpace: 'pre-wrap',
					}}
				>
					<code>{JSON.stringify(values, null, 2)}</code>
				</pre>
			</Tabs.Panel>

			<Tabs.Panel value="errors">
				<pre
					style={{
						fontSize: '12px',
						margin: 0,
						padding: '8px',
						backgroundColor: 'var(--plx-panel-bg-muted, var(--mantine-color-default-hover))',
						border: '1px solid var(--plx-panel-border, var(--mantine-color-default-border))',
						borderRadius: '4px',
						whiteSpace: 'pre-wrap',
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
			</Tabs.Panel>
		</Tabs>
	)
}
