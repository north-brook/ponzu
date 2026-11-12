import { Redirect } from "expo-router";

/**
 * A path this build has no screen for (a link to a screen a later version has): the launch
 * screen, which sends the app where the session says. Never an error page.
 */
export default function NotFound() {
  return <Redirect href="/" />;
}
