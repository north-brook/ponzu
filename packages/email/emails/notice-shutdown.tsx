import { FIXTURES } from "../src/fixtures.ts";
import { NoticeEmail, type NoticeProps } from "../src/templates/notice.tsx";

/** The `notice-shutdown` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: NoticeProps) {
  return <NoticeEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["notice-shutdown"]!.props as NoticeProps;
