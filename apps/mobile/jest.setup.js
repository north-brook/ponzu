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
// The keyboard's own stand-in: no keyboard, and its frame never moves.
jest.mock("react-native-keyboard-controller", () =>
  require("react-native-keyboard-controller/jest"),
);
// No microphone here: dictation is never available, so voice says so and typing works.
jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => false,
    requestPermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
    supportsOnDeviceRecognition: () => false,
    start: () => {},
    stop: () => {},
    abort: () => {},
  },
  useSpeechRecognitionEvent: () => {},
}));
// Gestures need a native recognizer: here a detector only draws what it holds, and a gesture
// is a builder that takes every setting and does nothing. Send is pressed the way VoiceOver
// presses it (`accessibilityTap`), sheets are left with their own buttons.
jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { View } = require("react-native");
  const builder = () =>
    new Proxy(
      {},
      {
        get: (_target, key, self) => (key === "then" ? undefined : () => self),
      },
    );
  return {
    GestureHandlerRootView: ({ children, ...props }) => React.createElement(View, props, children),
    GestureDetector: ({ children }) => children,
    Gesture: new Proxy({}, { get: () => builder }),
  };
});
// SwiftUI's text field, as a React Native one: the test types with `onTextChange`.
jest.mock("@expo/ui/swift-ui", () => {
  const React = require("react");
  const { TextInput, Text, View } = require("react-native");
  const TextField = React.forwardRef(function TextField(props, ref) {
    React.useImperativeHandle(ref, () => ({ focus: async () => {}, blur: async () => {} }));
    return React.createElement(TextInput, {
      testID: props.testID,
      value: props.text?.value,
      onChangeText: (t) => {
        if (props.text) props.text.value = t;
        props.onTextChange?.(t);
      },
    });
  });
  TextField.Placeholder = ({ children }) => React.createElement(View, null, children);
  return {
    Host: ({ children }) => React.createElement(View, null, children),
    Text: ({ children }) => React.createElement(Text, null, children),
    TextField,
    useNativeState: (initial) => React.useRef({ value: initial }).current,
  };
});
jest.mock("@expo/ui/swift-ui/modifiers", () => new Proxy({}, { get: () => () => ({}) }));
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
