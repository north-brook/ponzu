import { FIXTURES } from "../src/fixtures.ts";
import { MembersEmail, type MembersProps } from "../src/templates/members.tsx";

/** The `team-2` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: MembersProps) {
  return <MembersEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["team-2"]!.props as MembersProps;
