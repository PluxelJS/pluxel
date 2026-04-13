import { Box, Button, Card, Divider, Group, ScrollArea, Stack, Text } from '@mantine/core'
import { AutoForm } from '../../index'
import type { DensityMode } from './CaseHeader'

export interface FormPanelProps {
	density: DensityMode
}

export function FormPanel({ density }: FormPanelProps) {
	const sectionSpacing = density === 'compact' ? 'md' : 'xl'

	return (
		<Card
			withBorder
			style={{ flex: 1, minHeight: 320, height: '100%', display: 'flex', flexDirection: 'column' }}
		>
			<Stack gap="sm" style={{ height: '100%' }}>
				<Group justify="space-between" align="center">
					<Text fw={600}>表单配置</Text>
					<AutoForm.Actions>
						{({ submit, reset, dirty, canSubmit, submitting }) => (
							<Group gap="sm">
								<Button
									variant="default"
									onClick={() => reset()}
									disabled={!dirty || submitting}
									color="gray"
									type="button"
								>
									重置
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
				</Group>
				<Divider />
				<Box style={{ flex: 1, minHeight: 0 }}>
					<ScrollArea style={{ height: '100%' }} offsetScrollbars type="auto">
						<Box px="sm" pb={96}>
							<AutoForm.Fields sectionSpacing={sectionSpacing} />
						</Box>
					</ScrollArea>
				</Box>
			</Stack>
		</Card>
	)
}
