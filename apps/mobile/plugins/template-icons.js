const fs = require("node:fs/promises");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

/** The Hugeicons images the native menus name: `hi-*` (scripts/tab-icons.ts). */
const ICON = /^hi-.+\.imageset$/;

/** Sets one imageset's rendering intent in its Contents.json. */
async function intend(file, intent) {
  const contents = JSON.parse(await fs.readFile(file, "utf8"));
  contents.properties = { ...contents.properties, "template-rendering-intent": intent };
  await fs.writeFile(file, `${JSON.stringify(contents, null, 2)}\n`);
}

/**
 * Marks the Hugeicons in the asset catalog as template images, so a menu
 * tints them to its text in light and dark: expo-native-asset writes their
 * Contents.json without a rendering intent, which leaves them black in
 * dark mode. As augmenter's plugin of the same name.
 *
 * Listed before expo-native-asset in app.json: dangerous mods run in the
 * reverse of the order they're added, so this runs after it has written
 * the imagesets.
 */
module.exports = function withTemplateIcons(config) {
  return withDangerousMod(config, [
    "ios",
    async (modConfig) => {
      const { platformProjectRoot, projectName } = modConfig.modRequest;
      const catalog = path.join(platformProjectRoot, projectName, "Images.xcassets");
      const entries = await fs.readdir(catalog).catch(() => []);
      await Promise.all(
        entries
          .filter((entry) => ICON.test(entry))
          .map((entry) => intend(path.join(catalog, entry, "Contents.json"), "template")),
      );
      return modConfig;
    },
  ]);
};
