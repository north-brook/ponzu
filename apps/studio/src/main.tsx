// The canvas's own Tailwind build (pz-prefixed), compiled separately from the studio's.
import "@ponzu/react/tailwind.css";
import "./studio.css";
import { createRoot } from "react-dom/client";
import { Studio } from "./Studio.tsx";

const root = document.getElementById("root")!;
// /film is the timelapse renderer a host drives frame by frame: no studio around it.
if (location.pathname === "/film")
  void import("./film/page.tsx").then((m) => m.startFilmPage(root));
else createRoot(root).render(<Studio />);
