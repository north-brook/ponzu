import { FIXTURES } from "../src/fixtures.ts";
import { RecapEmail, type RecapProps } from "../src/templates/recap.tsx";

/** The `recap-1` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: RecapProps) {
  return <RecapEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["recap-1"]!.props as RecapProps;
