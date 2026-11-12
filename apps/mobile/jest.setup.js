// What the component tests need from native modules that jest-expo doesn't stand in for.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
// An iPhone's insets, without a native view to measure.
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
// Always online, unless a test says otherwise.
jest.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }),
}));
// Reanimated's own stand-in: animations land at once, and a loop (the turning slice) never
// keeps a test's act() waiting.
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
// Screens are rendered on their own, outside a navigator: each is in front, and where it
// sends the app is read from `router`'s calls.
jest.mock("expo-router", () => ({
  ...jest.requireActual("expo-router"),
  useIsFocused: () => true,
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    canDismiss: jest.fn(() => false),
    dismissAll: jest.fn(),
  },
}));
