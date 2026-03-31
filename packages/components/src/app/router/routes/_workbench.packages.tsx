import { createFileRoute } from '@tanstack/react-router'
import { PackageManagerPage } from '../../packages'

export const Route = createFileRoute('/_workbench/packages')({
	component: PackageManagerPage,
})
