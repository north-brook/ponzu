import type { Catalog } from "@ponzu/core";
import { useIsRestoring } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { boot } from "../lib/boot";
import { keys } from "../lib/mac-queries";
import { macs } from "../lib/macs";
import { openTarget } from "../lib/open-link";
import { queryClient } from "../lib/query";
import { Slice } from "../lib/slice";
import { track } from "../lib/telemetry";
import { brand } from "../lib/tokens";

/**
 * `ponzu://open?mac=<name>&file=<path>.design&artboard=<id>`, an agent's link to its work, as
 * ponzu.design/local hands it to whichever Ponzu takes it: opens that design, on that artboard,
 * from the paired Mac it's on. A link this phone can't follow says why, then goes to Designs.
 */
export default function OpenLink() {
  const params = useLocalSearchParams();
  const restoring = useIsRestoring();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // The saved Macs, and the cached catalogs a link without a Mac is looked up in.
    if (restoring) return;
    let on = true;
    boot().then(() => {
      if (!on) return;
      const has = (mac: string, key: string) =>
        Boolean(
          queryClient.getQueryData<Catalog>(keys.catalog(mac))?.files.some((f) => f.key === key),
        );
      const saved = macs.get();
      const to = openTarget(params, saved, has);
      track("link opened", { kind: to.kind });
      if (to.kind === "design") {
        const design = {
          pathname: "/design/[mac]/[key]" as const,
          params: { mac: to.mac, key: to.key, ...(to.artboard ? { artboard: to.artboard } : {}) },
        };
        // Back from the design goes where the person was, or to Designs on a cold start.
        if (router.canGoBack()) router.replace(design);
        else {
          router.replace("/designs");
          router.push(design);
        }
        return;
      }
      setError(
        to.kind === "unpaired"
          ? `That design is on ${to.mac}, which isn't paired with this iPhone. Pair it from Ponzu on that computer.`
          : to.kind === "missing"
            ? "None of your computers has that design."
            : "Ponzu on iPhone can't open that link.",
      );
      setTimeout(() => router.replace(saved.length ? "/designs" : "/tailscale"), 2_500);
    });
    return () => {
      on = false;
    };
  }, [restoring]);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: brand.yuzu,
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
      }}
    >
      <Slice size={112} bloom="loop" />
      {error && (
        <Text
          style={{
            marginHorizontal: 32,
            fontFamily: "Inter",
            fontWeight: "500",
            fontSize: 15,
            color: "rgba(17,17,16,0.72)",
            textAlign: "center",
          }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}
