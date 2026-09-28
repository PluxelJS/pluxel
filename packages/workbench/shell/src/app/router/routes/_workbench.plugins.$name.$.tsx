import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_workbench/plugins/$name/$')({
	component: () => null,
})
