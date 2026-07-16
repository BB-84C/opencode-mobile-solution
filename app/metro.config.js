const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(context, moduleName === 'punycode' ? 'punycode/' : moduleName, platform);

module.exports = config;
