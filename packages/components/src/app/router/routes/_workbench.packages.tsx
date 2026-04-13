import { createFileRoute } from '@tanstack/react-router'
import { PackageManagerScreen } from '../../packages/PackageManagerScreen'

export const Route = createFileRoute('/_workbench/packages')({
	component: PackageManagerScreen,
})
