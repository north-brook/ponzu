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
// An inline section's items are laid out in its place; a chosen one says so (`selected`), and a
// disabled one can't be pressed.
jest.mock("@react-native-menu/menu", () => {
  const { Pressable, View } = require("react-native");
  const React = require("react");
  const flat = (actions) =>
    actions.flatMap((action) => (action.subactions ? flat(action.subactions) : [action]));
  return {
    MenuView: ({ title, actions, onPressAction, children }) =>
      React.createElement(
        View,
        { testID: `menu ${title ?? ""}` },
        children,
        ...flat(actions).map((action) =>
          React.createElement(Pressable, {
            key: action.id,
            testID: `menu-${action.id}`,
            accessibilityRole: "menuitem",
            accessibilityLabel: action.title,
            accessibilityState: {
              selected: action.state === "on",
              disabled: !!action.attributes?.disabled,
            },
            disabled: !!action.attributes?.disabled,
            onPress: () => onPressAction?.({ nativeEvent: { event: action.id } }),
          }),
        ),
      ),
  };
});
// The photo library: a test says what the person picks (`global.picked`, assets), or nothing.
jest.mock("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: jest.fn(async () =>
    global.picked ? { canceled: false, assets: global.picked } : { canceled: true, assets: null },
  ),
}));
// Random ids without the native module (create keys are UUIDs).
jest.mock("expo-crypto", () => ({
  ...jest.requireActual("expo-crypto"),
  randomUUID: () => require("node:crypto").randomUUID(),
}));
// The keyboard's frame, without a keyboard: the library's own stand-in.
jest.mock("react-native-keyboard-controller", () =>
  require("react-native-keyboard-controller/jest"),
);
