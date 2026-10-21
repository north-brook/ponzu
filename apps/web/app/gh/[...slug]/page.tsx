import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { share } from "@/components/share";
import { DesignList, ViewerBar, ViewerErrorPage } from "../chrome";
import { DesignCanvas } from "../design-canvas";
import { type DesignView, loadDesign, loadRepo, type RepoView, ViewerError } from "../github";
import { parseTarget, type Target, viewerPath } from "../target";

/*
 * ponzu.design/gh/<owner>/<repo>/<path/to/name.design>: a design in a public
 * GitHub repo, on the real canvas, read-only. Without a .design in the path,
 * the repo's designs to pick from. See target.ts for the URL and github.ts for
 * the reading.
 *
 * Each path renders on its first visit and is kept five minutes, like the
 * newest-commit lookups under it. Errors GitHub may get over (a rate limit, an
 * outage) throw to error.tsx and are never kept.
 */
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

type Props = PageProps<"/gh/[...slug]">;

export async function generateMetadata(props: Props): Promise<Metadata> {
  const target = parseTarget((await props.params).slug);
  if (!target) return { title: "Not found", robots: { index: false } };
  const loaded = await load(target);
  if (loaded instanceof ViewerError)
    return { title: "Not found", robots: { index: false, follow: true } };

  if ("doc" in loaded) {
    const { repo, name, stats } = loaded;
    const title = `${name} · ${repo.fullName}`;
    const description = `${name}, a design in ${repo.fullName} on GitHub: ${plural(stats.pages, "page")} and ${plural(stats.artboards, "artboard")} of HTML and CSS, open on the Ponzu canvas.`;
    return {
      title: { absolute: `${title} — Ponzu` },
      description,
      ...share({ path: canonical(target, loaded), title, description }),
    };
  }
  const { repo, designs } = loaded;
  const title = `Designs in ${repo.fullName}`;
  const description = `${plural(designs.length, "design")} in ${repo.fullName} on GitHub, open on the Ponzu canvas.`;
  return {
    title: { absolute: `${title} — Ponzu` },
    description,
    ...share({ path: canonical(target, loaded), title, description }),
  };
}

export default async function Page(props: Props) {
  const target = parseTarget((await props.params).slug);
  if (!target) return <ViewerErrorPage kind="url" />;
  const loaded = await load(target);
  const repo = { owner: target.owner, repo: target.repo, ref: target.ref };

  if (loaded instanceof ViewerError)
    return (
      <ViewerErrorPage
        kind={loaded.kind}
        repo={loaded.kind === "design" ? viewerPath(repo) : undefined}
        repoUrl={
          loaded.kind === "repo" ? undefined : `https://github.com/${target.owner}/${target.repo}`
        }
      />
    );

  if (target.kind === "design" && target.extra) redirect(viewerPath(repo, target.path));

  if ("doc" in loaded)
    return (
      <div className="flex h-dvh flex-col">
        <ViewerBar
          repo={loaded.repo}
          gitRef={loaded.ref}
          refInUrl={loaded.refInUrl}
          commit={loaded.commit}
          path={loaded.path}
          name={loaded.name}
          githubUrl={loaded.githubUrl}
        />
        <div className="min-h-0 flex-1">
          <DesignCanvas doc={loaded.doc} assetBase={loaded.assetBase} />
        </div>
      </div>
    );

  // A repo with one design opens it; a folder lists what's in it, even if that's one.
  const only = loaded.designs.length === 1 && !loaded.prefix ? loaded.designs[0] : undefined;
  if (only) redirect(viewerPath(repo, only.path));
  return (
    <DesignList
      repo={loaded.repo}
      gitRef={loaded.ref}
      refInUrl={loaded.refInUrl}
      commit={loaded.commit}
      prefix={loaded.prefix}
      designs={loaded.designs}
      truncated={loaded.truncated}
    />
  );
}

/** The design or listing, or why not. Transient failures throw, so they reach error.tsx uncached. */
async function load(target: Target): Promise<DesignView | RepoView | ViewerError> {
  const ref = target.ref ?? "";
  try {
    return target.kind === "design"
      ? await loadDesign(target.owner, target.repo, ref, target.path)
      : await loadRepo(target.owner, target.repo, ref, target.prefix);
  } catch (e) {
    if (e instanceof ViewerError && !e.transient) return e;
    throw e;
  }
}

/** GitHub's own spelling of the owner and repo, so case variants share one canonical URL. */
function canonical(target: Target, loaded: DesignView | RepoView) {
  const repo = {
    owner: loaded.repo.owner,
    repo: loaded.repo.repo,
    ref: loaded.refInUrl ? loaded.ref : undefined,
  };
  return viewerPath(repo, target.kind === "design" ? target.path : target.prefix);
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
