import { createRoot } from "react-dom/client";
import { PhoneCanvas } from "./Canvas.tsx";
import { listen, send } from "./store.ts";

listen();
window.addEventListener("error", (e) =>
  send({ t: "error", message: String(e.error?.stack ?? e.message) }),
);
window.addEventListener("unhandledrejection", (e) =>
  send({ t: "error", message: String(e.reason) }),
);
createRoot(document.getElementById("root")!).render(<PhoneCanvas />);
send({ t: "ready" });
