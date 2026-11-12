// Component tests (`*.rntest.tsx`, `bun run test:rn`): React Native screens rendered with
// jest-expo and React Native Testing Library, against the in-app fake backend. `bun test` runs
// everything else; it can't render React Native, and it skips these by their name.
/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/ios",
  testMatch: ["<rootDir>/**/*.rntest.tsx"],
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/ios/", "<rootDir>/canvas/"],
  // lib/cloud/backend is the fake's file here, as Metro makes it with PONZU_BACKEND=fake.
  resolver: "<rootDir>/jest.resolver.js",
  setupFiles: ["<rootDir>/jest.setup.js"],
  // The workspace packages are TypeScript source, and these ship ES modules: all transformed.
  transformIgnorePatterns: [
    "node_modules/(?!(\\.bun/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|@react-native-async-storage|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|@hugeicons/.*|@tanstack/.*|hono|@neon/.*|nativewind|react-native-css|@ungap/.*|posthog-react-native|@react-native-menu/.*|parse5|entities|standard-navigation))",
  ],
};
