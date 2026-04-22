import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { Dashboard } from "./routes/Dashboard";
import { Chat } from "./routes/Chat";
import { What } from "./routes/What";

const rootRoute = createRootRoute({
  component: () => (
    <div style={{ minHeight: "100vh", background: "#111", color: "#c0c0c0" }}>
      <nav
        style={{
          display: "flex",
          gap: 0,
          padding: 0,
          borderBottom: "1px solid #333",
          alignItems: "center",
          background: "#0a0a0a",
        }}
      >
        <span
          style={{
            padding: "6px 12px",
            borderRight: "1px solid #333",
            color: "#c0c0c0",
            letterSpacing: 1,
            fontSize: 12,
          }}
        >
          [ eir ]
        </span>
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
        <Link to="/what" style={linkStyle} activeProps={{ style: activeLinkStyle }}>
          what is this
        </Link>
        <span
          style={{
            marginLeft: "auto",
            padding: "6px 12px",
            color: "#666",
            fontSize: 11,
            borderLeft: "1px solid #333",
          }}
        >
          elixir . phoenix . broadway . ets . pubsub
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

const whatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/what",
  component: What,
});

const routeTree = rootRoute.addChildren([dashboardRoute, chatRoute, whatRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const linkStyle: React.CSSProperties = {
  color: "#888",
  textDecoration: "none",
  fontSize: 12,
  padding: "6px 12px",
  borderRight: "1px solid #333",
};

const activeLinkStyle: React.CSSProperties = {
  color: "#fff",
  background: "#1a1a1a",
};
