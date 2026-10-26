import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { pairUrl, qrPath } from "@/lib/pair";

/** This Mac on the tailnet, from /api/info. */
export interface PairMachine {
  /** Host name, e.g. "macbook". Null when Tailscale isn't running. */
  name: string | null;
  /** MagicDNS name, e.g. "macbook.tail1.ts.net". Null without Tailscale or MagicDNS. */
  dns: string | null;
}

/**
 * Ponzu › Pair iPhone…: a code the phone app scans to find this Mac on the
 * tailnet. The desktop app opens it from its app menu; `?pair` opens it in a
 * browser. It asks the server for this Mac's tailnet name while it's open, so
 * turning Tailscale on shows the code without reopening it, and closes itself
 * once a phone pairs (the server's `pairedAt` moves on).
 */
export function PairIphone() {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("pair"));
  const [machine, setMachine] = useState<PairMachine | null>(null);

  useEffect(() => window.ponzuDesktop?.onPairIphone?.(() => setOpen(true)), []);

  const close = (next: boolean) => {
    setOpen(next);
    if (next) return;
    const url = new URL(location.href);
    if (!url.searchParams.has("pair")) return;
    url.searchParams.delete("pair");
    history.replaceState(null, "", url);
  };

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    /** The last pairing before this opened: a later one is the phone scanning this code. */
    let before: number | undefined;
    // No code until the first answer sets `before`, or a scan before it would become the baseline.
    setMachine(null);
    const ask = async () => {
      try {
        const res = await fetch("/api/info");
        const info = (await res.json()) as {
          machine?: Partial<PairMachine>;
          pairedAt?: number | null;
        };
        if (stopped) return;
        setMachine({ name: info.machine?.name ?? null, dns: info.machine?.dns ?? null });
        const paired = info.pairedAt ?? 0;
        if (before === undefined) before = paired;
        else if (paired > before) close(false);
      } catch {}
    };
    void ask();
    const timer = setInterval(ask, 2_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="gap-[22px] rounded-[18px] p-8 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_18px_50px_rgba(0,0,0,0.2),0_0_0_0.5px_rgba(0,0,0,0.12)] sm:max-w-[520px]">
        <PairBody machine={machine} />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's code and words, for this Mac as the server last described it. */
export function PairBody({ machine }: { machine: PairMachine | null }) {
  const host = machine?.dns;
  return (
    <div className="flex items-center gap-6">
      {host ? (
        <QrCode text={pairUrl(host)} />
      ) : (
        <div className="ghost size-[176px] shrink-0 rounded-[14px]" aria-hidden />
      )}
      <div className="flex flex-col gap-2.5">
        <DialogTitle className="font-bold font-display text-2xl leading-[1.15] tracking-[-0.02em]">
          Pair your iPhone
        </DialogTitle>
        <DialogDescription className="m-0 text-sm leading-normal">
          {host || !machine
            ? "Open Ponzu on your iPhone and scan this code. Both need Tailscale, signed in to the same account."
            : machine.name
              ? "Turn on MagicDNS for your tailnet to pair an iPhone. The phone finds this Mac by its tailnet name."
              : "Turn on Tailscale on this Mac to pair an iPhone."}
        </DialogDescription>
      </div>
    </div>
  );
}

/** Dark on white in either theme: cameras read a code best that way round. */
function QrCode({ text }: { text: string }) {
  const { size, d } = qrPath(text);
  return (
    <div className="size-[176px] shrink-0 rounded-[14px] bg-white p-3 shadow-[0_0_0_1px_rgba(17,17,16,0.1)]">
      <svg
        role="img"
        aria-label="Pairing code"
        data-pair={text}
        viewBox={`0 0 ${size} ${size}`}
        className="block size-full"
        shapeRendering="crispEdges"
      >
        <path d={d} fill="#111110" />
      </svg>
    </div>
  );
}
