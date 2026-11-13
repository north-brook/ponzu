import { FIXTURES } from "../src/fixtures.ts";
import { RecapEmail, type RecapProps } from "../src/templates/recap.tsx";

/** The `recap-3` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: RecapProps) {
  return <RecapEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["recap-3"]!.props as RecapProps;
