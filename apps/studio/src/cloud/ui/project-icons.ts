/*
 * What a design is made in, as an icon: the one place these are chosen, so a repo and Scratch
 * read the same in the picker, its chip, the sidebar's rows and Settings. Draw them through
 * `Icon` at the size and stroke where they sit.
 */
import { FolderClockIcon, FolderGitIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "./icon.tsx";

/** A repo: the folder with git's mark. */
export const REPO_ICON: IconSvgElement = FolderGitIcon;

/** Scratch: the temporary folder (a folder with a clock), kept in Ponzu rather than a repo. */
export const SCRATCH_ICON: IconSvgElement = FolderClockIcon;
