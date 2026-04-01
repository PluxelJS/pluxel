// DebugValues.tsx
import { Paper, Tabs } from '@mantine/core'

export function DebugValues({ formValues }: { formValues: any }) {
	const { values, errorMap, errors } = formValues

	return (
		<Tabs defaultValue="values" variant="pills">
			<Tabs.List mb="xs">
				<Tabs.Tab value="values">表单值</Tabs.Tab>
				<Tabs.Tab value="errors">错误信息</Tabs.Tab>
			</Tabs.List>

			<Tabs.Panel value="values">
				<Paper
					component="pre"
					withBorder
					radius="sm"
					p="sm"
					style={{
						fontSize: '12px',
						margin: 0,
						whiteSpace: 'pre-wrap',
					}}
				>
					<code>{JSON.stringify(values, null, 2)}</code>
				</Paper>
			</Tabs.Panel>

			<Tabs.Panel value="errors">
				<Paper
					component="pre"
					withBorder
					radius="sm"
					p="sm"
					style={{
						fontSize: '12px',
						margin: 0,
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
				</Paper>
			</Tabs.Panel>
		</Tabs>
	)
}
