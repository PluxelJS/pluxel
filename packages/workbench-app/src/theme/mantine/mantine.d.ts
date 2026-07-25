import type { PlxMantineMetadata } from './mantineAdapter'

declare module '@mantine/core' {
	interface MantineThemeOther extends PlxMantineMetadata {}
}
