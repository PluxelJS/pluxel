import pkgJson from '../../package.json'

// The workspace package has a private identity; the native executable remains pncat.
export const NAME = 'pncat'

export const VERSION = pkgJson.version
