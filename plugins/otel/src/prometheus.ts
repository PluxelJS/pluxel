import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus'
import { AggregationTemporality, MetricReader } from '@opentelemetry/sdk-metrics'

export type PrometheusScrape = Readonly<{
	body: string
	collectionErrorCount: number
}>

export class PrometheusPullReader extends MetricReader {
	private readonly serializer = new PrometheusSerializer()
	private pendingScrape: Promise<PrometheusScrape> | undefined
	private active = true

	constructor() {
		super({
			aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
		})
	}

	scrape(): Promise<PrometheusScrape> {
		if (!this.active) return Promise.reject(new Error('Prometheus metric reader is stopped'))
		if (this.pendingScrape) return this.pendingScrape

		const scrape = this.collect().then(({ resourceMetrics, errors }) => ({
			body: this.serializer.serialize(resourceMetrics),
			collectionErrorCount: errors.length,
		}))
		this.pendingScrape = scrape
		const clearPending = () => {
			if (this.pendingScrape === scrape) this.pendingScrape = undefined
		}
		void scrape.then(clearPending, clearPending)
		return scrape
	}

	protected override async onForceFlush(): Promise<void> {
		await this.pendingScrape
	}

	protected override async onShutdown(): Promise<void> {
		this.active = false
		await this.pendingScrape
	}
}
