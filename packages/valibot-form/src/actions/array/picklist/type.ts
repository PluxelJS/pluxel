import type { PicklistOptions } from 'valibot'

export type PicklistCheck = {
	options: PicklistOptions
}

export type PicklistItems = { value: string | number | bigint; label: string }[]
type Props = PicklistCheck & {
	items?: PicklistItems
}
export type PicklistMetaOptions =
	| { type: 'radio'; props: Props }
	| { type: 'select'; props: Props }
