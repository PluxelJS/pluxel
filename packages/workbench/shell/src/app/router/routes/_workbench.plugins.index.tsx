import { createFileRoute } from '@tanstack/react-router'
import { EmptyState } from '../../../components'
import { useDocumentWorkspace } from '../../workbench/document'

function PluginsIndexRoute() {
	useDocumentWorkspace('plugins')
	return (
		<EmptyState
			title="选择插件"
			description="从左侧目录打开插件配置。目录支持分组、拖拽排序和多选；运行状态作为筛选条件保留。"
			minHeight="100%"
		/>
	)
}

export const Route = createFileRoute('/_workbench/plugins/')({
	staticData: { worksplit: { title: '插件' } },
	component: PluginsIndexRoute,
})
