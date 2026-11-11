import { version } from "../package.json";

/** The runner's version, sent as `X-Ponzu-Client: runner/<version>`. */
export const VERSION: string = version;
