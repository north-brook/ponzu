const { join } = require("node:path");
const { backendFile, isSingleton, outsideApp } = require("./metro.resolve");
// Reanimated's own (and through it Worklets'): their web builds under Jest, not the native ones.
const animated = require("react-native-reanimated/jest/resolver");

/*
 * Jest's resolver, as Metro resolves for the app (metro.resolve.js):
 * - lib/cloud/backend is the fake's file, as metro.config.js makes it under PONZU_BACKEND=fake;
 * - React and TanStack Query come from the app, whoever imports them;
 * - what the workspace packages' source needs once Babel has transformed it (@babel/runtime)
 *   is found from the app, since bun installs each package's dependencies beside it alone.
 */
module.exports = (request, options) => {
  const origin = join(options.basedir, "x.ts");
  const swapped = backendFile(origin, request, __dirname);
  if (swapped) return swapped;
  const fromApp = { ...options, basedir: __dirname };
  if (isSingleton(request) && outsideApp(origin, __dirname)) return animated(request, fromApp);
  try {
    return animated(request, options);
  } catch (error) {
    if (request.startsWith(".") || !outsideApp(origin, __dirname)) throw error;
    return animated(request, fromApp);
  }
};
