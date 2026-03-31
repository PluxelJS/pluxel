import { createFileRoute } from '@tanstack/react-router'
import { StandaloneShell } from '../../frames/StandaloneShell'

export const Route = createFileRoute('/_standalone')({
	component: StandaloneShell,
})
