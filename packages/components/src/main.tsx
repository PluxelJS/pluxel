import { MantineProvider } from '@mantine/core'
import type { ReactNode } from 'react'
export function AppProvider({ children }: { children: ReactNode }) {
	return <MantineProvider>{children}</MantineProvider>
}
