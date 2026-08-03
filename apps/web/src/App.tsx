import { Show, UserButton, useAuth } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { getMe, setAuthTokenGetter, type UserMe } from "./api/client";
import { Explore } from "./pages/Explore";
import { Login } from "./pages/Login";
import { Machines } from "./pages/Machines";
import { Overview } from "./pages/Overview";
import { Recommendations } from "./pages/Recommendations";
import { Settings } from "./pages/Settings";

export function App() {
  const { getToken, isLoaded } = useAuth();

  // Registered synchronously during render, not inside a useEffect: React
  // commits a subtree's effects bottom-up (children's effects fire before
  // the parent's), so a useEffect here would run *after* e.g. Dashboard's
  // own mount-time fetch effect when both mount in the same commit — that
  // first request would go out with no Authorization header and 401. A
  // plain call in the component body runs before React even renders any
  // children, so the getter is always in place before anything can fetch.
  setAuthTokenGetter(() => getToken());

  // Show's "signed-out"/"signed-in" branches both render nothing until
  // Clerk finishes its startup round-trip (isLoaded), which otherwise reads
  // as a blank white page rather than a loading state.
  if (!isLoaded) {
    return <div className="login-page muted">Loading…</div>;
  }

  return (
    <>
      <Show when="signed-out">
        <Login />
      </Show>
      <Show when="signed-in">
        <Dashboard />
      </Show>
    </>
  );
}

function Dashboard() {
  const [user, setUser] = useState<UserMe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load account");
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  if (!user) {
    // Clerk has already authenticated this user by the time Dashboard
    // mounts — only our own /v1/auth/me JIT-provisioning call can fail
    // here. Without an escape hatch, a 401/500/timeout on that call would
    // otherwise strand a signed-in user on a bare error string with no way
    // to retry or sign out (the old code fell back to the Login page on a
    // failed session probe; Clerk owns that now, so we provide our own).
    return (
      <div className="login-page muted">
        <div>{error ?? "Loading…"}</div>
        {error ? (
          <button type="button" className="btn" onClick={() => void refreshMe()}>
            Retry
          </button>
        ) : null}
        <UserButton />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">TokenOps</div>
        <NavLink className={navClass} to="/" end>
          Overview
        </NavLink>
        <NavLink className={navClass} to="/explore">
          Explore
        </NavLink>
        <NavLink className={navClass} to="/recommendations">
          Recommendations
        </NavLink>
        <NavLink className={navClass} to="/machines">
          Machines
        </NavLink>
        <NavLink className={navClass} to="/settings">
          Settings
        </NavLink>
        <div className="sidebar-footer">
          <div>{user.email}</div>
          <UserButton />
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview user={user} />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/machines" element={<Machines />} />
          <Route
            path="/settings"
            element={<Settings user={user} onUserUpdated={(u) => setUser(u)} />}
          />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? "nav-link active" : "nav-link";
}
