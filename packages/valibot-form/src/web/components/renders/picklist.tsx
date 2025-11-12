import { Text } from '@mantine/core'
import type { CommonProps } from '~/core/registry'
import { registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { FieldChrome } from '../shared'
import { PicklistControl } from './controls/PicklistControl'

type RendererProps = CommonProps<typeof META_MAP.PICKLIST> & { value?: unknown }

function PicklistField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const ep = extractedPropsInfo ?? {}

	return (
		<FieldChrome
			label={formBaseInfo.label}
			required={formBaseInfo.required}
			description={formBaseInfo.description}
			helperText={formBaseInfo.helperText}
			hint={formBaseInfo.hint}
			tooltip={formBaseInfo.tooltip}
			badge={formBaseInfo.badge}
			errors={(errors ?? []).map((err) => err.message)}
		>
			<PicklistControl
				meta={{
					options: ep.options,
					entries: ep.entries,
					labels: ep.labels,
					disabled: ep.disabled,
					placeholder: ep.placeholder,
					searchable: ep.searchable,
					clearable: ep.clearable ?? !formBaseInfo.required,
					maxSelections: ep.maxSelections,
					allowCreate: ep.allowCreate,
					variant: ep.variant,
					multiple: ep.multiple,
					nothingFoundLabel: ep.nothingFoundLabel,
				}}
				required={formBaseInfo.required}
				value={value}
				onChange={(next) => triggerFormEvents(inputProps, next)}
				disabled={inputProps.disabled}
			/>
			{ep.multiple && ep.maxSelections ? (
				<Text size="xs" c="dimmed" mt={4}>
					最多可选择 {ep.maxSelections} 项
				</Text>
			) : null}
		</FieldChrome>
	)
}

registerRenderer(META_MAP.PICKLIST, (props) => <PicklistField {...(props as RendererProps)} />)
