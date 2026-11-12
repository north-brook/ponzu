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
// A test says which screen is on show (`useSegments`) and what its route was given
// (`useLocalSearchParams`).
jest.mock("expo-router", () => ({
  ...jest.requireActual("expo-router"),
  useIsFocused: () => true,
  useSegments: jest.fn(() => []),
  useLocalSearchParams: jest.fn(() => ({})),
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => false),
    canDismiss: jest.fn(() => false),
    dismissAll: jest.fn(),
  },
}));
// iOS's paste control, as a button: pressing it pastes what a test put on `global.clipboard`.
jest.mock("expo-clipboard", () => {
  const { Pressable } = require("react-native");
  const React = require("react");
  return {
    isPasteButtonAvailable: true,
    ClipboardPasteButton: ({ onPress, testID }) =>
      React.createElement(Pressable, {
        testID,
        accessibilityRole: "button",
        accessibilityLabel: "Paste",
        onPress: () => onPress({ type: "text", text: global.clipboard ?? "" }),
      }),
  };
});
// The system's menu on a held view, as its items laid out as buttons beside it, in a view named
// `menu <title>`: a test presses one as a person picks it from the held view's menu.
jest.mock("@react-native-menu/menu", () => {
  const { Pressable, View } = require("react-native");
  const React = require("react");
  return {
    MenuView: ({ title, actions, onPressAction, children }) =>
      React.createElement(
        View,
        { testID: `menu ${title ?? ""}` },
        children,
        ...actions.map((action) =>
          React.createElement(Pressable, {
            key: action.id,
            testID: `menu-${action.id}`,
            accessibilityRole: "menuitem",
            accessibilityLabel: action.title,
            onPress: () => onPressAction?.({ nativeEvent: { event: action.id } }),
          }),
        ),
      ),
  };
});
