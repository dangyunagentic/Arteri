import { createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routes";
import { Providers } from "./router-core";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(
  <Providers>
    <RouterProvider router={router} />
  </Providers>
);
