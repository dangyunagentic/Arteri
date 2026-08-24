import { createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routes";
import { Providers } from "./router-core";
import { Overlays } from "./toast";
import "./pulse.css";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(
  <Providers>
    <Overlays>
      <RouterProvider router={router} />
    </Overlays>
  </Providers>
);
