// babel-preset-expo adds the worklets plugin Reanimated needs on its own.
// NativeWind v5 needs no Babel setup.
module.exports = (api) => {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
