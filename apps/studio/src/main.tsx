import "./pz.css";
import "./studio.css";
import { createRoot } from "react-dom/client";
import { Studio } from "./Studio.tsx";

const root = document.getElementById("root")!;
createRoot(root).render(<Studio />);
