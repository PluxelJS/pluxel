import { Badge, Group, Radio, Text, Tooltip, ActionIcon } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'
import { useAutoFormCtx, webRenderers, type ScalarRendererProps } from 'valibot-form/web'

export function ManagedBooleanField(props: ScalarRendererProps<'boolean'>) {
	const { sections } = useAutoFormCtx()
	const { node, path, value, errors, inputProps } = props
	let field = sections.flatMap(({ fields }) => fields).find(({ name }) => name === path[0])?.node
	for (const key of path.slice(1)) {
		field = field?.kind === 'object' ? field.fields.find(({ name }) => name === key) : undefined
	}
	// Rows and branch fields belong to their collection's atomic Host path.
	if (field?.kind !== 'boolean') return <webRenderers.boolean {...props} />

	const selected =
		value === undefined ? 'inherit' : value === true ? 'on' : value === false ? 'off' : ''
	const error = errors
		?.map((issue) => (typeof issue === 'string' ? issue : issue.message))
		.join('\n')
	const locked = inputProps.disabled || inputProps.readOnly
	const { badge, hint } = node.meta
	return (
		<Radio.Group
			id={inputProps.id}
			name={inputProps.name}
			value={selected}
			label={node.meta.hideLabel ? undefined : node.meta.label}
			withAsterisk={!node.meta.hideLabel && node.required && !node.meta.hideRequired}
			aria-label={node.meta.label}
			aria-invalid={inputProps['aria-invalid']}
			aria-describedby={inputProps['aria-describedby']}
			description={node.meta.description}
			descriptionProps={{ id: inputProps.descriptionId }}
			error={error}
			errorProps={{ id: inputProps.errorId, style: { whiteSpace: 'pre-line' } }}
			onBlur={inputProps.onBlur}
			onChange={(choice) => {
				if (!locked) inputProps.onChange?.(choice === 'inherit' ? undefined : choice === 'on')
			}}
		>
			<Group gap="md" mt="xs">
				<Radio value="inherit" label="继承" disabled={locked} />
				<Radio value="on" label="开" disabled={locked} />
				<Radio value="off" label="关" disabled={locked} />
				{!node.meta.hideLabel && badge ? (
					<Badge size="xs" color={typeof badge === 'string' ? 'gray' : badge.color}>
						{typeof badge === 'string' ? badge : badge.label}
					</Badge>
				) : null}
				{!node.meta.hideLabel && hint ? (
					<Tooltip label={hint}>
						<ActionIcon variant="subtle" size="xs" aria-label="字段提示" type="button">
							<IconInfoCircle size={14} />
						</ActionIcon>
					</Tooltip>
				) : null}
			</Group>
			{node.meta.help ? (
				<Text size="xs" c="dimmed" mt="xs">
					{node.meta.help}
				</Text>
			) : null}
		</Radio.Group>
	)
}
