import * as v from 'valibot'
import * as f from 'valibot-form'
import { workbench } from '@pluxel/workbench'
import { WretchWorkbench } from '@pluxel/wretch/workbench'
import type { ReportStudioApi } from './ReportStudio.contracts'

export type {
	ReportStudioApi,
	ShowcaseArtifact,
	ShowcaseCacheStats,
	ShowcaseObserver,
	ShowcaseRendererKind,
	ShowcaseRenderRequest,
	ShowcaseSnapshot,
} from './ReportStudio.contracts'

const StudioStatus = v.object({
	renderer: v.pipe(v.string(), f.formMeta({ title: '可选渲染引擎' })),
	storage: v.pipe(v.string(), f.formMeta({ title: '存储提供者' })),
	cacheHits: v.pipe(v.number(), f.formMeta({ title: '缓存命中' })),
	cacheMisses: v.pipe(v.number(), f.formMeta({ title: '缓存未命中' })),
	cacheEntries: v.pipe(v.number(), f.formMeta({ title: '缓存条目' })),
})
const RecentArtifacts = v.array(
	v.object({
		title: v.pipe(v.string(), f.formMeta({ title: '标题' })),
		engine: v.pipe(v.string(), f.formMeta({ title: '渲染引擎' })),
		bytes: v.pipe(v.number(), f.formMeta({ title: '字节数' })),
		cacheHit: v.pipe(v.boolean(), f.formMeta({ title: '使用缓存' })),
	}),
)

export const ReportStudioWorkbench = workbench.define({
	studioGuide: workbench.content({
		document: workbench.markdown(import.meta.url, './studio-guide.md'),
		placement: workbench.panel('left', { label: '操作指南', order: 10 }),
	}),
	studioStatus: workbench.content({
		document: workbench.markdown(import.meta.url, './studio-status.md', {
			status: workbench.data(StudioStatus),
		}),
		placement: workbench.panel('right', { label: '渲染状态', order: 10 }),
	}),
	studioArtifacts: workbench.content({
		document: workbench.markdown(import.meta.url, './studio-artifacts.md', {
			artifacts: workbench.data(RecentArtifacts),
		}),
		placement: workbench.panel('bottom', { label: '最近产物', order: 10 }),
	}),
	studio: workbench.view<ReportStudioApi>({
		renderer: workbench.entry(import.meta.url, './ui/studio.tsx'),
		placement: workbench.route('/architecture-lab', {
			title: 'Pluxel Architecture Lab',
			navigation: { label: 'Architecture Lab' },
			order: 1,
		}),
	}),
	httpSettings: WretchWorkbench.settings.place(
		workbench.tab({
			label: 'Outbound HTTP',
			icon: workbench.icons.Settings,
			order: 20,
		}),
	),
})
