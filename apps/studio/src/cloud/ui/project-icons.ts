/*
 * What a design is made in, as an icon: the one place these are chosen, so a repo and Scratch
 * read the same in the picker, the sidebar's rows and Settings (the create page's selector, in
 * its header beside the logo, draws none). Draw them through
 * `Icon` at the size and stroke where they sit.
 */
import { Folder01Icon, FolderGitIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "./icon.tsx";

/** A repo: the folder with git's mark. */
export const REPO_ICON: IconSvgElement = FolderGitIcon;

/**
 * Scratch: the folder drawn dashed, as the design draws it: a place for a design that is in no
 * repo (yet). Hugeicons has no dashed folder, so this is its plain one with the design's dashes.
 */
export const SCRATCH_ICON: IconSvgElement = Folder01Icon.map(([tag, attrs]) => [
  tag,
  { ...attrs, strokeDasharray: "3 2.6" },
]);
