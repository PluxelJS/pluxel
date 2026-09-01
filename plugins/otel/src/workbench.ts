import { f, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'

const ExportStatus = v.object({
	state: v.pipe(
		v.picklist(['disabled', 'waiting', 'healthy', 'failing']),
		f.formMeta({ title: '状态' }),
	),
	errorType: v.pipe(v.nullable(v.string()), f.formMeta({ title: '最近错误类型' })),
})

const RuntimeStatus = v.pipe(
	v.object({
		metrics: v.pipe(ExportStatus, f.formMeta({ title: 'Metrics exporter' })),
		traces: v.pipe(ExportStatus, f.formMeta({ title: 'Traces exporter' })),
		logs: v.pipe(ExportStatus, f.formMeta({ title: 'Logs exporter' })),
		prometheus: v.pipe(
			v.object({
				state: v.pipe(v.picklist(['disabled', 'listening']), f.formMeta({ title: '状态' })),
				path: v.pipe(v.nullable(v.string()), f.formMeta({ title: '抓取路径' })),
			}),
			f.formMeta({ title: 'Prometheus' }),
		),
	}),
	f.formMeta({ title: '运行状态' }),
)

export type OtelWorkbenchStatus = v.InferOutput<typeof RuntimeStatus>

export const OtelWorkbench = workbench.define({
	operations: workbench.content({
		document: workbench.markdown(import.meta.url, './workbench-guide.md', {
			status: workbench.data(RuntimeStatus),
			flush: workbench.action({ label: '立即导出待处理 telemetry' }),
		}),
		placement: workbench.tab({
			label: '运维说明',
			icon: workbench.icons.TextRecognition,
			order: 80,
		}),
	}),
})
