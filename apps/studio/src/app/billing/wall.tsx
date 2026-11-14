import { queryKeys } from "@ponzu/client/query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AddCardDialog,
  CapReachedDialog,
  FreeCreditsDialog,
  PaymentFailedDialog,
} from "../../cloud/dialogs/billing-dialogs.tsx";
import type { Analytics } from "../analytics/analytics.ts";
import { useAnalytics } from "../analytics/provider.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { BillingWall } from "./wall.ts";

/*
 * The billing wall in the window (wall.ts says what it does). One per workspace window: the
 * create page, the open canvas's sends, its billing line and Plan and usage all reach the same
 * one through `useBillingWall()`, and `BillingWallDialogs` draws whichever dialog is open.
 */

const WallContext = createContext<BillingWall | null>(null);

/** The window's billing wall; null outside a workspace window (the gallery, a test). */
export function useBillingWall(): BillingWall | null {
  return useContext(WallContext);
}

/** The wall for a workspace window, made once and let go of with it. */
export function useBillingWallFor(host: Host): BillingWall {
  const { queryClient } = usePonzu();
  // Analytics loads after the window does: the wall captures through whichever is current.
  const current = useAnalytics();
  const analytics = useRef<Analytics>(current);
  analytics.current = current;
  const [wall] = useState(
    () =>
      new BillingWall({
        api: host.api,
        openExternal: (url) => host.openExternal(url),
        onLink: (listener) => host.onLink(listener),
        ...(host.comeForward ? { comeForward: () => host.comeForward?.() } : {}),
        refresh: (workspaceId) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.usage(workspaceId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
        },
        analytics: {
          capture: ((...args: Parameters<Analytics["capture"]>) =>
            analytics.current.capture(...args)) as Analytics["capture"],
        },
      }),
  );
  useEffect(() => () => wall.close(), [wall]);
  return wall;
}

export function BillingWallProvider({
  wall,
  children,
}: {
  wall: BillingWall;
  children: ReactNode;
}) {
  return (
    <WallContext.Provider value={wall}>
      {children}
      <BillingWallDialogs wall={wall} />
    </WallContext.Provider>
  );
}

/** The dialog that is open, kept as it was while it closes. */
export function BillingWallDialogs({ wall }: { wall: BillingWall }) {
  const { open, dialog, details } = useSyncExternalStore(wall.subscribe, wall.getSnapshot);
  if (!dialog || !details) return null;
  const dismiss = () => wall.dismiss();
  switch (dialog.kind) {
    case "free_used":
      return (
        <FreeCreditsDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={details.workspaceName}
          canAddCard={details.canManage}
          defaultCapUsd={details.capUsd}
          status={dialog.card.status}
          error={dialog.card.error}
          onSubmit={(capUsd) => void wall.submitCard(capUsd)}
          onCancel={() => wall.cancelCard()}
        />
      );
    case "add_card":
      return (
        <AddCardDialog
          open={open}
          onDismiss={dismiss}
          defaultCapUsd={details.capUsd}
          status={dialog.card.status}
          error={dialog.card.error}
          onSubmit={(capUsd) => void wall.submitCard(capUsd)}
          onCancel={() => wall.cancelCard()}
        />
      );
    case "cap_reached":
      return (
        <CapReachedDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={details.workspaceName}
          canRaise={details.canManage}
          capUsd={details.capUsd}
          billedUsd={details.billedCents / 100}
          periodEnd={details.periodEnd}
          status={dialog.status}
          error={dialog.error}
          onSubmit={(capUsd) => void wall.submitCap(capUsd)}
        />
      );
    case "payment_failed":
      return (
        <PaymentFailedDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={details.workspaceName}
          canPay={details.canManage}
          onPay={() => void wall.payInvoice()}
        />
      );
  }
}
