// The canvas's own Tailwind build (pz-prefixed), compiled separately from the studio's.
import "@ponzu/react/tailwind.css";
import "./studio.css";
import { createRoot } from "react-dom/client";
import { Studio } from "./Studio.tsx";

createRoot(document.getElementById("root")!).render(<Studio />);
