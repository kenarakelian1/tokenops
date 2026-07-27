import { useCallback, useEffect, useState } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { ApiError, getMe, logout, type UserMe } from "./api/client";
import { Explore } from "./pages/Explore";
import { Login } from "./pages/Login";
import { Machines } from "./pages/Machines";
import { Overview } from "./pages/Overview";
import { Recommendations } from "./pages/Recommendations";
import { Settings } from "./pages/Settings";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authed"; user: UserMe };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const navigate = useNavigate();

  const refreshMe = useCallback(async () => {
    try {
      const user = await getMe();
      setAuth({ status: "authed", user });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuth({ status: "anonymous" });
        return;
      }
      // Network / other errors: treat as anonymous so Login is reachable
      setAuth({ status: "anonymous" });
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const onLoggedIn = (user: UserMe) => {
    setAuth({ status: "authed", user });
    navigate("/");
  };

  const onLogout = async () => {
    try {
      await logout();
    } catch {
      // ignore
    }
    setAuth({ status: "anonymous" });
    navigate("/login");
  };

  const onUserUpdated = (user: UserMe) => {
    setAuth({ status: "authed", user });
  };

  if (auth.status === "loading") {
    return <div className="login-page muted">Loading…</div>;
  }

  if (auth.status === "anonymous") {
    return (
      <Routes>
        <Route path="/login" element={<Login onLoggedIn={onLoggedIn} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const { user } = auth;

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
          <button type="button" className="btn-ghost" onClick={() => void onLogout()}>
            Log out
          </button>
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
            element={<Settings user={user} onUserUpdated={onUserUpdated} />}
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
