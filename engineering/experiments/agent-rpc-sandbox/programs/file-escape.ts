declare const require: (name: string) => any

async function run() {
	const fs = require('node:fs')
	const attempts = ['/etc/pluxel-escape', '/rpc/escape']
	return attempts.map((path) => {
		try {
			fs.writeFileSync(path, 'escape')
			return 'wrote'
		} catch (error: any) {
			return error.code
		}
	})
}
