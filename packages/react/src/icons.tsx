import {
  Add01Icon,
  Archive01Icon,
  ArrowTurnBackwardIcon,
  ArrowTurnForwardIcon,
  Book01Icon,
  Calendar01Icon,
  Cancel01Icon,
  ChartLineData01Icon,
  CheckmarkCircle01Icon,
  CodeIcon,
  Comment01Icon,
  ComputerIcon,
  Copy01Icon,
  Cursor01Icon,
  DashboardSquare01Icon,
  Delete02Icon,
  File01Icon,
  FileEmpty02Icon,
  FlowConnectionIcon,
  Folder01Icon,
  FolderGitIcon,
  FolderOpenIcon,
  FrameIcon,
  GitBranchIcon,
  GridViewIcon,
  HandIcon,
  Home01Icon,
  Image01Icon,
  LaptopIcon,
  Layout01Icon,
  LeftToRightListBulletIcon,
  Location01Icon,
  Mail01Icon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  Note01Icon,
  PaintBoardIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  SentIcon,
  Settings01Icon,
  ShoppingCart01Icon,
  SmartPhone01Icon,
  StarIcon,
  Sun01Icon,
  Tablet01Icon,
  TestTube01Icon,
  TextFontIcon,
  Tick02Icon,
  Unarchive03Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SLICE, SLICE_STROKE } from "./slice.ts";

export const Icons = {
  add: Add01Icon,
  archive: Archive01Icon,
  undo: ArrowTurnBackwardIcon,
  redo: ArrowTurnForwardIcon,
  book: Book01Icon,
  /** A blank page: a .design file. */
  blank: FileEmpty02Icon,
  /** A page with no icon of its own. */
  board: DashboardSquare01Icon,
  calendar: Calendar01Icon,
  close: Cancel01Icon,
  chart: ChartLineData01Icon,
  resolved: CheckmarkCircle01Icon,
  code: CodeIcon,
  comment: Comment01Icon,
  desktop: ComputerIcon,
  copy: Copy01Icon,
  select: Cursor01Icon,
  trash: Delete02Icon,
  file: File01Icon,
  flow: FlowConnectionIcon,
  folder: Folder01Icon,
  folderOpen: FolderOpenIcon,
  /** A git repository: a project. */
  repo: FolderGitIcon,
  branch: GitBranchIcon,
  grid: GridViewIcon,
  hand: HandIcon,
  home: Home01Icon,
  image: Image01Icon,
  laptop: LaptopIcon,
  layout: Layout01Icon,
  list: LeftToRightListBulletIcon,
  map: Location01Icon,
  mail: Mail01Icon,
  minus: MinusSignIcon,
  more: MoreHorizontalIcon,
  moon: Moon02Icon,
  note: Note01Icon,
  page: FrameIcon,
  palette: PaintBoardIcon,
  edit: PencilEdit02Icon,
  plus: PlusSignIcon,
  refresh: RefreshIcon,
  search: Search01Icon,
  send: SentIcon,
  settings: Settings01Icon,
  cart: ShoppingCart01Icon,
  phone: SmartPhone01Icon,
  star: StarIcon,
  scratch: TestTube01Icon,
  sun: Sun01Icon,
  tablet: Tablet01Icon,
  type: TextFontIcon,
  check: Tick02Icon,
  unarchive: Unarchive03Icon,
  user: UserIcon,
} as const;

export type IconName = keyof typeof Icons;

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.6,
  className,
}: {
  name: IconName | string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const icon = Icons[name as IconName] ?? File01Icon;
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} className={className} />;
}

/** The Ponzu slice, in one color: ink, or paper on dark. `color` overrides both. */
export function Logo({
  size = 20,
  dark = false,
  color,
}: {
  size?: number;
  dark?: boolean;
  color?: string;
}) {
  const fill = color ?? (dark ? "#F4F3EF" : "#111110");
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Ponzu">
      <g fill={fill} stroke={fill} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** Agent product marks for presence. */
export function AgentMark({ client, size = 14 }: { client?: string; size?: number }) {
  if (client === "claude") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Claude">
        <path
          fill="#D97757"
          d="m4.7 15.96 4.72-2.65.08-.23-.08-.13h-.23l-.79-.05-2.7-.07-2.34-.1-2.27-.12-.57-.12L0 11.79l.06-.35.48-.32.69.06 1.52.1 2.28.16 1.65.1 2.45.25h.39l.05-.16-.13-.1-.1-.1-2.36-1.6-2.55-1.69-1.34-.97-.72-.5-.37-.46-.16-1.01.66-.73.88.06.22.06.9.69 1.91 1.48 2.5 1.84.36.3.15-.1.02-.07-.17-.27-1.36-2.46-1.45-2.5-.65-1.04-.17-.62a3 3 0 0 1-.1-.74l.75-1.02.42-.13 1 .13.42.37.62 1.42 1 2.24 1.56 3.04.46.9.24.83.09.25h.16v-.15l.13-1.71.24-2.1.23-2.7.08-.76.37-.91.75-.49.58.28.48.69-.07.44-.28 1.85-.56 2.9-.36 1.95h.21l.24-.24.98-1.3 1.65-2.07.73-.82.85-.9.55-.43h1.03l.76 1.13-.34 1.17-1.06 1.35-.88 1.14-1.27 1.7-.79 1.36.07.11.19-.02 2.86-.61 1.55-.28 1.84-.32.83.39.09.4-.33.81-1.97.49-2.31.46-3.44.81-.04.03.05.06 1.55.15.66.04h1.62l3.02.22.79.52.47.64-.08.49-1.21.62-1.64-.39-3.82-.91-1.31-.33h-.18v.11l1.09 1.07 2 1.81 2.51 2.33.13.58-.32.45-.34-.05-2.2-1.66-.85-.75-1.93-1.62h-.13v.17l.44.65 2.34 3.52.12 1.08-.17.35-.61.21-.67-.12-1.37-1.92-1.41-2.17-1.14-1.94-.14.08-.67 7.26-.32.37-.72.28-.6-.46-.32-.74.32-1.46.38-1.9.31-1.5.28-1.88.17-.62-.01-.04-.14.02-1.42 1.95-2.16 2.92-1.71 1.83-.41.16-.71-.37.07-.66.4-.58 2.36-3 1.42-1.86.92-1.08-.01-.15h-.05l-6.28 4.08-1.12.14-.48-.45.06-.74.23-.24 1.89-1.3Z"
        />
      </svg>
    );
  }
  if (client === "openai") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="OpenAI">
        <path
          fill="currentColor"
          d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .75 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.99 5.99 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06l-4.83 2.79a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87Zm16.6 3.86-5.83-3.39 2.01-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.66Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.39.68Zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.6-1.5Z"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Agent">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );
}
