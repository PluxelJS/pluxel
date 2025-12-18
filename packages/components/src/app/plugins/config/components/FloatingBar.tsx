import { Affix, Button, Group, Paper, Text } from '@mantine/core'
import { SavedStatus } from './SavedStatus'

export function FloatingBar(props: {
	title: string
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
	onSubmit(): void
	onCancel(): void
	onResetToDefaults(): void
	savedAt?: number
}) {
	const { title, dirty, canSubmit, submitting, onSubmit, onCancel, onResetToDefaults, savedAt } =
		props

	return (
		<Affix position={{ bottom: 16, right: 16 }} withinPortal zIndex={1000}>
			<Paper
				withBorder
				radius="xl"
				p="xs"
				shadow="md"
				style={{
					opacity: dirty || submitting ? 1 : 0.7,
					transition: 'opacity 120ms ease',
				}}
				styles={{ root: { '&:hover': { opacity: 1 } } }}
			>
				<Group gap="sm" wrap="nowrap" align="center">
					<Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
						<Text
							fw={600}
							size="sm"
							style={{
								maxWidth: 220,
								overflow: 'hidden',
								whiteSpace: 'nowrap',
								textOverflow: 'ellipsis',
							}}
							title={title}
						>
							{title}
						</Text>
						<SavedStatus dirty={dirty} savedAt={savedAt} />
					</Group>
					<Group gap="xs" wrap="nowrap">
						<Button
							id={`cancel-fab-${title}`}
							variant="default"
							onClick={onCancel}
							disabled={!dirty || submitting}
						>
							取消
						</Button>
						<Button
							id={`reset-fab-${title}`}
							variant="subtle"
							onClick={onResetToDefaults}
							disabled={submitting}
						>
							重置
						</Button>
						<Button
							id={`submit-fab-${title}`}
							onClick={onSubmit}
							disabled={!canSubmit}
							loading={submitting}
						>
							{submitting ? '提交中…' : '提交'}
						</Button>
					</Group>
				</Group>
			</Paper>
		</Affix>
	)
}

