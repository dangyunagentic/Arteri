// Root route + query client. Kept tiny so routes.tsx stays readable.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import "../src/tokens.css";

export const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

export { Outlet };

export const qc = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
