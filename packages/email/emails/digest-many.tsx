import { FIXTURES } from "../src/fixtures.ts";
import { DigestEmail, type DigestProps } from "../src/templates/digest.tsx";

/** The `digest-many` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: DigestProps) {
  return <DigestEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["digest-many"]!.props as DigestProps;
