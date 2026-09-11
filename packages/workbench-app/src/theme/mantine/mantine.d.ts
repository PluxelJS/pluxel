import type { PlxMantineThemeMetadata } from './theme'

declare module '@mantine/core' {
	interface MantineThemeOther extends PlxMantineThemeMetadata {}
}
