/*
 * A send from the create page, as the window drives it (app/main-window.tsx): the composer
 * travels to the thread, the canvas's view arrives with the sent words as its first line, and
 * after the beat the thread's pane closes, unless the person has gone to it. Local state stands
 * in for the API. `?fail=<ms>` makes the canvas fail that long after the send; `?beat=<ms>`
 * changes the beat (so a test can hold the pane open long enough to step past it).
 *
 * For the browser tests: `window.gallerySends` counts sends that went, `window.gallerySettled`
 * says how the pane ended ("open" or "closed"), once it has, and `window.gallerySending` whether
 * a send's travel or beat is still under way.
 */
import { useEffect, useState } from "react";
import type { ProjectChoice } from "../create/create.ts";
import { CreatePage } from "../create/create-page.tsx";
import { takeOff } from "../create/flight.ts";
import { LANDING_BEAT_MS, type Sent, useLanding } from "../create/landing.ts";
import type { Effort, ThreadItem } from "../model.ts";
import { ThreadRail } from "../thread/rail.tsx";
import { CanvasChrome } from "../window/canvas-chrome.tsx";
import * as f from "./fixtures.ts";
import { Harness } from "./harness.tsx";
import { said } from "./thread-fixtures.ts";

const ignore = () => {};

type Gallery = {
  gallerySends?: number;
  gallerySettled?: "open" | "closed";
  gallerySending?: boolean;
};

export function SendHarness({ initialPrompt = "" }: { initialPrompt?: string }) {
  const params = new URLSearchParams(location.search);
  const failAfter = params.has("fail") ? Number(params.get("fail")) || 0 : null;
  const beat = Number(params.get("beat")) || LANDING_BEAT_MS;
  const [prompt, setPrompt] = useState(initialPrompt);
  const [project, setProject] = useState<ProjectChoice>({ kind: "repo", repo: f.fernwood });
  const [model, setModel] = useState({ model: f.models[0]!.id, effort: "high" as Effort });
  // The canvas's view: shown from the send, gone again if it fails.
  const [items, setItems] = useState<ThreadItem[] | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const launched = items !== null;
  const rail = sent ? true : launched && railOpen;

  useLanding(
    sent,
    (open) => {
      setSent(null);
      setRailOpen(open);
      (window as Gallery).gallerySettled = open ? "open" : "closed";
    },
    beat,
  );
  useEffect(() => {
    (window as Gallery).gallerySending = sent !== null;
  }, [sent]);

  const send = () => {
    const text = prompt.trim();
    if (!text || launched) return;
    const origin = takeOff(document.querySelector("[data-create-dock]"));
    const w = window as Gallery;
    w.gallerySends = (w.gallerySends ?? 0) + 1;
    setError(null);
    setItems([said(f.ada, text)]);
    setSent({ key: crypto.randomUUID(), origin });
    if (failAfter !== null) {
      setTimeout(() => {
        // Back to the page as it was: the words, the project; no second travel.
        setSent(null);
        setItems(null);
        setError("That canvas couldn't be made. Try again.");
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>("[data-create-composer] textarea")?.focus(),
        );
      }, failAfter);
    } else {
      setPrompt("");
    }
  };

  return (
    <Harness
      canvases={f.soloCanvases}
      openId={null}
      rail={rail}
      railContent={
        items ? (
          <ThreadRail
            canvasId="cnv_sent"
            meId={f.ada.id}
            repoName={project.kind === "repo" ? project.repo.name : null}
            items={items}
            older="none"
            onLoadOlder={ignore}
            agent={{ state: "waking", status: null }}
            asks={[]}
            gate={null}
            attachments={[]}
            onAttach={ignore}
            onRemoveAttachment={ignore}
            onRetryAttachment={ignore}
            onSend={ignore}
            onStop={ignore}
            onAnswer={ignore}
            onDismissAsk={ignore}
            renderDrawing={() => null}
            onOpenComment={ignore}
            onOpenArtboards={ignore}
            onOpenPullRequest={ignore}
            onOpenLink={ignore}
          />
        ) : undefined
      }
      chrome={
        launched
          ? (sidebarOpen) => (
              <CanvasChrome
                name="Pricing page"
                sidebarOpen={sidebarOpen}
                pages={[]}
                activePageId={null}
                onSelectPage={ignore}
                onAddPage={null}
                team={null}
                pullRequest={null}
                action={null}
                rail={{
                  open: rail,
                  signal: "working",
                  onToggle: () => {
                    setSent(null);
                    setRailOpen(!rail);
                  },
                }}
              />
            )
          : undefined
      }
    >
      <CreatePage
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={send}
        onAttach={ignore}
        launched={launched}
        model={{
          models: f.models,
          efforts: ["low", "medium", "high", "xhigh", "max"],
          model: model.model,
          effort: model.effort,
          onChange: (m, e) => setModel({ model: m, effort: e }),
        }}
        project={project}
        repos={f.repos}
        onProjectChange={setProject}
        onAllowMore={ignore}
        ideas={null}
      />
      {error ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
          <div
            role="status"
            className="rounded-pill bg-surface px-3.5 py-1.5 text-12 text-muted shadow-pop"
          >
            {error}
          </div>
        </div>
      ) : null}
    </Harness>
  );
}
