import { Slice } from "../cloud/ui/marks.tsx";
import { AppWindow } from "../cloud/window/app-window.tsx";

/**
 * A shipped studio with no shell under it: the app's own bridge didn't load, so nothing can
 * sign in or reach a design. Said plainly, with nowhere to click but a fresh download.
 */
export function CantStart() {
  return (
    <AppWindow
      // No shell to ask: a Mac's window has its lights in the chrome, others their title bar.
      lights={/Mac/.test(navigator.userAgent) ? "native" : "none"}
      sidebar={null}
      rail={null}
    >
      <div
        data-screen="cant-start"
        className="absolute inset-0 flex flex-col items-center pt-[230px]"
      >
        <Slice size={72} className="text-ink" />
        <h1 className="m-0 mt-11 font-display font-semibold text-[28px] tracking-[-0.02em]">
          Ponzu couldn't start
        </h1>
        <p className="m-0 mt-3.5 max-w-[420px] text-center text-[15px] text-muted leading-[1.55]">
          Part of this copy of Ponzu is missing. Download it again from{" "}
          <a
            href="https://ponzu.design"
            target="_blank"
            rel="noreferrer"
            className="text-ink underline underline-offset-2"
          >
            ponzu.design
          </a>
          ; your designs are safe in the cloud.
        </p>
      </div>
    </AppWindow>
  );
}
