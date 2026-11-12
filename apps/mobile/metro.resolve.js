const { dirname, join, resolve } = require("node:path");

/*
 * How the app's bundle resolves two things Metro's defaults get wrong for it. Shared by
 * metro.config.js and jest.resolver.js, and tested in imports.test.ts.
 */

/**
 * The fake backend's file when `moduleName`, imported from `origin`, is lib/cloud/backend; else
 * null. Metro uses it only under PONZU_BACKEND=fake; the component tests always.
 */
function backendFile(origin, moduleName, root) {
  if (!moduleName.startsWith(".")) return null;
  const real = join(root, "lib", "cloud", "backend");
  const target = resolve(dirname(origin), moduleName).replace(/\.ts$/, "");
  return target === real ? `${real}.fake.ts` : null;
}

/**
 * Packages there must be one copy of. The workspace packages the app runs from source
 * (@ponzu/client above all) have their own development copies of React and TanStack Query
 * beside them, and Metro, like Node, would take the nearest: a second React breaks every hook,
 * a second QueryClient context every query. These always resolve from the app.
 */
const SINGLETONS = ["react", "react-dom", "react-native", "@tanstack/react-query"];

function isSingleton(moduleName) {
  return SINGLETONS.some((name) => moduleName === name || moduleName.startsWith(`${name}/`));
}

/** Whether `origin` is outside the app (and its node_modules), where a singleton must not resolve. */
function outsideApp(origin, root) {
  return !resolve(origin).startsWith(`${resolve(root)}/`);
}

module.exports = { backendFile, isSingleton, outsideApp, SINGLETONS };
