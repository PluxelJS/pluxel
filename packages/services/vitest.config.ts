import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	oxc: { decorator: { legacy: true } },
})
