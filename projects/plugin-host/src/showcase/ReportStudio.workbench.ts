import { workbench } from '@pluxel/runtime/workbench'
import { WretchWorkbench } from '@pluxel/wretch/workbench'
import type { ReportStudioApi } from './ReportStudio.contracts'

export type {
	ReportStudioApi,
	ShowcaseArtifact,
	ShowcaseCacheStats,
	ShowcaseObserver,
	ShowcaseRendererKind,
	ShowcaseSnapshot,
} from './ReportStudio.contracts'

export const ReportStudioWorkbench = workbench.define({
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
