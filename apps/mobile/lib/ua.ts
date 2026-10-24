import Constants from "expo-constants";
import { Platform } from "react-native";
import { userAgent } from "./ua-string";

/**
 * This release's version. An over-the-air update carries its own app.json,
 * so this is the version of the JavaScript running, not of the binary.
 */
export const VERSION = Constants.expoConfig?.version ?? "0.0.0";

/** `Ponzu-iOS/<version> (iPhone; iOS <os>)`, for every request and socket. */
export const USER_AGENT = userAgent(VERSION, Platform.Version);

export { userAgent };
