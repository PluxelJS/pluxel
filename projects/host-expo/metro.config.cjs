const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const config = getDefaultConfig(__dirname)

// The isolated Expo install links the same compiled packages used by the other hosts.
for (const directory of ['../../packages', '../../node_modules', '../host-targets/plugins']) {
	config.watchFolders.push(path.resolve(__dirname, directory))
}

module.exports = config
