import { Redirect } from "expo-router";

/**
 * `<scheme>://auth/callback`: the auth session takes this redirect itself, so one that arrives
 * as a link is stray (a sign-in sheet closed late, a link opened by hand). It signs nobody in;
 * the launch screen sends the app where the session says.
 */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
