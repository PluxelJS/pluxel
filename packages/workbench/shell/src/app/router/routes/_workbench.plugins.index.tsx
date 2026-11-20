import { createFileRoute } from '@tanstack/react-router'
import { EmptyState } from '../../../components'
import { useDocumentWorkspace } from '../../workbench/document'

function PluginsIndexRoute() {
	useDocumentWorkspace('plugins')
	return <EmptyState title="选择插件" minHeight="100%" />
}

export const Route = createFileRoute('/_workbench/plugins/')({
	staticData: { worksplit: { title: '插件' } },
	component: PluginsIndexRoute,
})
