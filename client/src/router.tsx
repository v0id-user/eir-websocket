import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { Dashboard } from "./routes/Dashboard";
import { Chat } from "./routes/Chat";

const rootRoute = createRootRoute({
  component: () => (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#eee",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      <nav
        style={{
          display: "flex",
          gap: 16,
          padding: "10px 20px",
          borderBottom: "1px solid #222",
          alignItems: "center",
        }}
      >
        <strong style={{ color: "#4ade80" }}>eir</strong>
        <Link to="/" style={linkStyle} activeProps={{ style: activeLinkStyle }}>
          dashboard
        </Link>
        <Link
          to="/g/$groupId"
          params={{ groupId: "general" }}
          style={linkStyle}
          activeProps={{ style: activeLinkStyle }}
        >
          chat
        </Link>
        <span style={{ marginLeft: "auto", color: "#666", fontSize: 12 }}>
          elixir · phoenix · broadway · ets · pubsub
        </span>
      </nav>
      <Outlet />
    </div>
  ),
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/g/$groupId",
  component: Chat,
});

const routeTree = rootRoute.addChildren([dashboardRoute, chatRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const linkStyle: React.CSSProperties = {
  color: "#aaa",
  textDecoration: "none",
  fontSize: 13,
};

const activeLinkStyle: React.CSSProperties = {
  color: "#4ade80",
};
