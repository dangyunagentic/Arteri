// Route tree: /login, /share/:slug (public), console shell with auth guard.
import { rootRoute } from "./router-core";
import { createRoute, redirect } from "@tanstack/react-router";
import Login from "./pages/Login";
import Console from "./Console";
import Overview from "./pages/Overview";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Keys from "./pages/Keys";
import UsagePage from "./pages/Usage";
import Share from "./pages/Share";

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/console" });
  },
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
});

export const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share/$slug",
  component: Share,
});

export const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "console",
  component: Console,
});

export const consoleIndex = createRoute({
  getParentRoute: () => consoleRoute,
  path: "/",
  component: Overview,
});
export const providersR = createRoute({
  getParentRoute: () => consoleRoute,
  path: "providers",
  component: Providers,
});
export const modelsR = createRoute({
  getParentRoute: () => consoleRoute,
  path: "models",
  component: Models,
});
export const keysR = createRoute({
  getParentRoute: () => consoleRoute,
  path: "keys",
  component: Keys,
});
export const usageR = createRoute({
  getParentRoute: () => consoleRoute,
  path: "usage",
  component: UsagePage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  shareRoute,
  consoleRoute.addChildren([consoleIndex, providersR, modelsR, keysR, usageR]),
]);
