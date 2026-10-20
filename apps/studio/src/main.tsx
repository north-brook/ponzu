import "@ponzu/react/styles.css";
import "./studio.css";
import { createRoot } from "react-dom/client";
import { Studio } from "./Studio.tsx";

createRoot(document.getElementById("root")!).render(<Studio />);
