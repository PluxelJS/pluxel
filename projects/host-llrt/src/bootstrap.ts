import '@formatjs/intl-getcanonicallocales/polyfill.js'
import '@formatjs/intl-locale/polyfill.js'
import '@formatjs/intl-pluralrules/polyfill.js'
import '@formatjs/intl-pluralrules/locale-data/en.js'
import '@formatjs/intl-numberformat/polyfill.js'
import '@formatjs/intl-numberformat/locale-data/en.js'

export async function run(
	sourceUrl: string,
	issue: (name: string) => string,
	installedEntry: string | null,
	pid: number,
) {
	const application = await import('./application')
	return application.run(sourceUrl, issue, installedEntry, pid)
}
