import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Key01Icon,
  Layers01Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { Fragment, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import type { Repo } from "../model.ts";
import { Waiting } from "../setup/step.tsx";
import { ago, useNow } from "../time.ts";
import { cn } from "../ui/cn.ts";
import { TextField } from "../ui/field.tsx";
import { useFocusReturn } from "../ui/focus-return.ts";
import { Icon } from "../ui/icon.tsx";
import { TEXT } from "../ui/ladder.ts";
import { REPO_ICON } from "../ui/project-icons.ts";
import {
  canSaveSecret,
  type RepoEnvironment,
  SECRET_MASK,
  type StackItem,
  secretName,
  secretNameError,
} from "./environments.ts";
import { QuietButton, RowIcon, Section } from "./parts.tsx";
import { STACK_LOGOS } from "./stack-logos.ts";

export interface EnvironmentsSectionProps {
  /** The workspace's repos that have a base: one has, once a design has run in it. */
  environments: RepoEnvironment[];
  /** The repos shown open, by id; the app remembers them on this device. */
  open: string[];
  onOpenChange: (open: string[]) => void;
  /** Admins add, change and remove secrets; everyone else sees their names. */
  canEdit: boolean;
  /** Who can push to a repo may rebuild its base; left out, everyone may. */
  canRebuild?: (repo: Repo) => boolean;
  /** Under the list: what a change to a secret does, and when. */
  note?: string;
  onRebuild: (repo: Repo) => void;
  /**
   * Adds a secret, or replaces the value of one by its name. When it answers a promise, the
   * field stays open with what was typed until it settles, and stays open if it is refused.
   */
  onSaveSecret: (repo: Repo, name: string, value: string) => unknown;
  onRemoveSecret: (repo: Repo, name: string) => void;
}

/**
 * Each repo's environment, one row each that opens: the base Claude built there, shown by its
 * stack, with Rebuild; and the secrets its sandboxes get, whose values are never shown again.
 */
export function EnvironmentsSection({
  environments,
  open,
  onOpenChange,
  note,
  ...props
}: EnvironmentsSectionProps) {
  return (
    <Section label="Repos" note={environments.length ? note : undefined}>
      {environments.length ? (
        environments.map((env) => {
          const isOpen = open.includes(env.repo.id);
          return (
            <RepoEnvironmentRow
              key={env.repo.id}
              env={env}
              open={isOpen}
              onToggle={() =>
                onOpenChange(
                  isOpen ? open.filter((id) => id !== env.repo.id) : [...open, env.repo.id],
                )
              }
              {...props}
            />
          );
        })
      ) : (
        <p className="m-0 flex min-h-12 items-center text-13 text-muted">
          Nothing here yet. Ponzu sets a repo up the first time you design in it.
        </p>
      )}
    </Section>
  );
}

function RepoEnvironmentRow({
  env,
  open,
  onToggle,
  canEdit,
  onRebuild,
  onSaveSecret,
  onRemoveSecret,
  canRebuild = () => true,
}: Omit<EnvironmentsSectionProps, "environments" | "open" | "onOpenChange" | "note"> & {
  env: RepoEnvironment;
  open: boolean;
  onToggle: () => void;
}) {
  const { repo, base, secrets } = env;
  const panel = `env-${repo.id}`;
  return (
    <div className="flex flex-col border-rule not-last:border-b">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={onToggle}
        className="flex min-h-12 cursor-default items-center gap-2.5 rounded-6 py-1.5 text-left outline-none focus-ring"
      >
        <Icon icon={REPO_ICON} step="control" className="text-muted" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-13 text-ink">{repo.name}</span>
          <span className="truncate text-12 text-faint">
            {repo.owner}/{repo.name}
          </span>
        </span>
        <span className="flex-1" />
        {open ? null : (
          <span className="mr-1 flex items-center gap-[5px]" aria-hidden>
            {base.stack.map((item) => (
              <StackLogo key={item.slug} item={item} size={13} />
            ))}
            <span className="w-1.5" />
            <Icon icon={Key01Icon} step="small" className="text-faint" />
            <span className="text-12 text-faint tabular-nums">{secrets.length}</span>
          </span>
        )}
        <Icon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          step="inline"
          className="text-faint"
        />
      </button>
      {open ? (
        <div id={panel} className="mb-3 ml-[26px] flex flex-col rounded-10 bg-secondary">
          <CardHead icon={Layers01Icon} label="Base">
            <BaseAge base={base} />
          </CardHead>
          <div className="flex items-center px-2.5 pt-1.5 pb-2.5">
            {base.stack.map((item) => (
              <span
                key={item.slug}
                className="mr-2.5 inline-flex items-center gap-[5px] whitespace-nowrap text-11 text-muted"
              >
                <StackLogo item={item} size={11} />
                {item.label}
              </span>
            ))}
            {base.status === "none" ? (
              <span className="text-12 text-faint">Ponzu sets it up as a design here starts.</span>
            ) : null}
            <span className="flex-1" />
            {base.status !== "none" && canRebuild(repo) ? (
              <QuietButton
                disabled={base.status === "building" || base.status === "requested"}
                onClick={() => onRebuild(repo)}
              >
                {base.status === "failed" ? "Try again" : "Rebuild"}
              </QuietButton>
            ) : null}
          </div>
          <div className="mx-2.5 h-px bg-rule" />
          {/* A repo's secrets as they are written: never recorded (app/analytics/privacy.ts). */}
          <div className="ph-no-capture flex flex-col">
            <Secrets
              env={env}
              canEdit={canEdit}
              onSave={(name, value) => onSaveSecret(repo, name, value)}
              onRemove={(name) => onRemoveSecret(repo, name)}
            />
          </div>
          <span className="h-2" />
        </div>
      ) : null}
    </div>
  );
}

function CardHead({
  icon,
  label,
  children,
}: {
  icon: Parameters<typeof Icon>[0]["icon"];
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-0.5">
      <Icon icon={icon} step="meta" className="text-faint" />
      <span className={cn("flex-1 uppercase tracking-[0.02em]", TEXT.label)}>{label}</span>
      {children}
    </div>
  );
}

function BaseAge({ base }: { base: RepoEnvironment["base"] }) {
  const now = useNow();
  if (base.status === "building") {
    return (
      <span className="flex items-center gap-1.5 text-12 text-faint">
        <Waiting size={12} />
        Rebuilding…
      </span>
    );
  }
  if (base.status === "failed") return <span className="text-12 text-danger">Rebuild failed</span>;
  if (base.status === "requested") {
    return <span className="text-12 text-faint">Rebuilds at the next start</span>;
  }
  return base.builtAt ? (
    <span className="text-12 text-faint">Built {ago(base.builtAt, now, "long")}</span>
  ) : null;
}

/** A stack item's mark: its logo, or for a slug without one its label's first letter in a tile. */
function StackLogo({ item, size }: { item: StackItem; size: number }) {
  const logo = STACK_LOGOS[item.slug];
  if (!logo) {
    return (
      <span
        aria-hidden
        className="grid shrink-0 place-items-center rounded-3 bg-step font-semibold text-muted leading-none"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.7) }}
      >
        {item.label.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="block shrink-0">
      <path d={logo.d} style={{ fill: logo.color }} />
    </svg>
  );
}

/** What is being written: a new secret, or a new value for one by its name. */
type Draft = { name: string; value: string; replacing: string | null };

function Secrets({
  env,
  canEdit,
  onSave,
  onRemove,
}: {
  env: RepoEnvironment;
  canEdit: boolean;
  onSave: (name: string, value: string) => unknown;
  onRemove: (name: string) => void;
}) {
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // Why the API refused the last save (a reserved name, say), said under the row it's about
  // until what was typed changes.
  const [refusal, setRefusal] = useState<string | null>(null);
  const setDraft = (next: Draft | null) => {
    setRefusal(null);
    setDraftState(next);
  };
  const errorId = useId();
  // Remove asks once more, in place, before a secret goes: its value can't be read back.
  const [removing, setRemoving] = useState(false);
  // An edit ends with focus back on what opened it: Add, or the secret's pencil.
  const focus = useFocusReturn();
  const close = () => {
    focus.returnTo(draft?.replacing ?? "add");
    setDraft(null);
    setRemoving(false);
  };
  const ok = draft
    ? draft.replacing
      ? draft.value.length > 0
      : canSaveSecret(draft.name, draft.value, env.secrets)
    : false;
  const save = async () => {
    if (!draft || !ok || saving) return;
    setSaving(true);
    try {
      await onSave(draft.name, draft.value);
      close();
    } catch (error) {
      // Refused: what was typed stays, with the reason right under it.
      setRefusal(
        error instanceof Error && error.message ? error.message : "Couldn't save it. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      close();
    }
  };
  const adding = draft && !draft.replacing ? draft : null;
  const nameError = adding ? (secretNameError(adding.name, env.secrets) ?? refusal) : null;
  const say = (text: string, id: string) => (
    <p id={id} role="alert" className="m-0 mx-2.5 pt-1 pb-1.5 text-12 text-danger leading-[1.4]">
      {text}
    </p>
  );
  const saveButton = (
    <QuietButton disabled={!ok || saving} onClick={() => void save()}>
      Save
    </QuietButton>
  );
  return (
    <>
      <CardHead icon={Key01Icon} label="Secrets">
        {canEdit && !adding ? (
          <button
            ref={focus.target("add")}
            type="button"
            onClick={() => setDraft({ name: "", value: "", replacing: null })}
            className="flex cursor-default items-center gap-[5px] rounded-4 font-medium text-12 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-ink"
          >
            <Icon icon={Add01Icon} step="small" />
            Add
          </button>
        ) : null}
      </CardHead>
      <span className="h-1.5" />
      {env.secrets.map((secret) =>
        draft?.replacing === secret.name ? (
          <Fragment key={secret.name}>
            <SecretRow name={<SecretName>{secret.name}</SecretName>}>
              {removing ? (
                <>
                  <span className="truncate text-12 text-muted">Remove it from this repo?</span>
                  <button
                    type="button"
                    autoFocus
                    data-keeps-escape
                    onClick={() => {
                      onRemove(secret.name);
                      focus.returnTo("add");
                      setDraft(null);
                      setRemoving(false);
                    }}
                    onKeyDown={keys}
                    className="cursor-default rounded-4 font-medium text-12 text-danger outline-none focus-ring hover:underline"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoving(false)}
                    className="cursor-default rounded-4 font-medium text-12 text-muted outline-none focus-ring hover:text-ink"
                  >
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <TextField
                    compact
                    mono
                    autoFocus
                    data-keeps-escape
                    type="password"
                    aria-label={`New value for ${secret.name}`}
                    invalid={refusal !== null}
                    aria-describedby={refusal ? `${errorId}-value` : undefined}
                    placeholder="New value"
                    value={draft.value}
                    onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                    onKeyDown={keys}
                    className="w-[180px]"
                  />
                  {saveButton}
                  <button
                    type="button"
                    onClick={() => setRemoving(true)}
                    className="cursor-default rounded-4 font-medium text-12 text-danger outline-none focus-ring hover:underline"
                  >
                    Remove
                  </button>
                </>
              )}
            </SecretRow>
            {refusal && !removing ? say(refusal, `${errorId}-value`) : null}
          </Fragment>
        ) : (
          <SecretRow key={secret.name} name={<SecretName>{secret.name}</SecretName>}>
            <span className="font-mono text-12 text-muted">{SECRET_MASK}</span>
            {canEdit ? (
              <RowIcon
                ref={focus.target(secret.name)}
                icon={PencilEdit02Icon}
                label={`Edit ${secret.name}`}
                onClick={() => setDraft({ name: secret.name, value: "", replacing: secret.name })}
              />
            ) : null}
          </SecretRow>
        ),
      )}
      {adding ? (
        <>
          <div className="mx-2.5 flex h-8 items-center gap-2">
            <TextField
              compact
              mono
              autoFocus
              data-keeps-escape
              aria-label="Name"
              placeholder="NAME"
              invalid={nameError !== null}
              aria-describedby={nameError ? `${errorId}-name` : undefined}
              value={adding.name}
              onChange={(e) => setDraft({ ...adding, name: secretName(e.target.value) })}
              onKeyDown={keys}
              className="min-w-0 flex-1"
            />
            <TextField
              compact
              mono
              data-keeps-escape
              type="password"
              aria-label="Value"
              placeholder="Value"
              value={adding.value}
              onChange={(e) => setDraft({ ...adding, value: e.target.value })}
              onKeyDown={keys}
              className="min-w-0 flex-1"
            />
            {saveButton}
          </div>
          {nameError ? say(nameError, `${errorId}-name`) : null}
        </>
      ) : null}
    </>
  );
}

function SecretRow({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-2.5 flex h-8 items-center gap-2.5">
      {name}
      <span className="flex-1" />
      {children}
    </div>
  );
}

function SecretName({ children }: { children: string }) {
  return <span className="truncate font-medium font-mono text-12 text-ink">{children}</span>;
}
