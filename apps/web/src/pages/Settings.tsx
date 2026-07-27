import { useState, type FormEvent } from "react";
import {
  createPat,
  getMe,
  putSettings,
  type UserMe,
} from "../api/client";

type Props = {
  user: UserMe;
  onUserUpdated: (user: UserMe) => void;
};

export function Settings({ user, onUserUpdated }: Props) {
  const initial =
    user.budgetUsdMonthly != null && user.budgetUsdMonthly !== ""
      ? String(user.budgetUsdMonthly)
      : "";
  const [budget, setBudget] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [patName, setPatName] = useState("agent");
  const [patBusy, setPatBusy] = useState(false);
  const [patError, setPatError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const trimmed = budget.trim();
      const value =
        trimmed === "" ? null : Number(trimmed);
      if (value != null && (!Number.isFinite(value) || value < 0)) {
        setError("Budget must be a non-negative number or empty");
        setBusy(false);
        return;
      }
      const res = await putSettings({ budgetUsdMonthly: value });
      const me = await getMe();
      onUserUpdated({
        ...me,
        budgetUsdMonthly: res.budgetUsdMonthly,
      });
      setBudget(
        res.budgetUsdMonthly != null ? String(res.budgetUsdMonthly) : "",
      );
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCreatePat(e: FormEvent) {
    e.preventDefault();
    setPatBusy(true);
    setPatError(null);
    setCreatedToken(null);
    try {
      const name = patName.trim() || "agent";
      const res = await createPat(name);
      setCreatedToken(res.token);
    } catch (err) {
      setPatError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setPatBusy(false);
    }
  }

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted" style={{ marginTop: "-0.5rem" }}>
        Account preferences. Soft monthly budget drives an Overview banner only
        (no external alerts in Phase 1).
      </p>

      <form className="form" onSubmit={(e) => void onSubmit(e)}>
        <label>
          Monthly budget (USD, estimated)
          <input
            type="number"
            min={0}
            step="0.01"
            placeholder="e.g. 50"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Leave empty to clear. Compared against estimated 30-day spend.
        </p>
        {error ? <div className="error">{error}</div> : null}
        {message ? <div className="muted">{message}</div> : null}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>

      <h2>Agent access token</h2>
      <p className="muted" style={{ maxWidth: 40 + "rem" }}>
        Create a personal access token for the local agent (
        <code>cloud.ingest_token</code>). The raw token is shown once — copy it
        into <code>~/.tokenops/config.toml</code>.
      </p>
      <form className="form" onSubmit={(e) => void onCreatePat(e)}>
        <label>
          Token name
          <input
            type="text"
            value={patName}
            onChange={(e) => setPatName(e.target.value)}
            placeholder="agent"
            maxLength={128}
          />
        </label>
        {patError ? <div className="error">{patError}</div> : null}
        {createdToken ? (
          <div className="card" style={{ maxWidth: 480 }}>
            <div className="label">New token (copy now)</div>
            <code style={{ wordBreak: "break-all", fontSize: "0.85rem" }}>
              {createdToken}
            </code>
          </div>
        ) : null}
        <button className="btn" type="submit" disabled={patBusy}>
          {patBusy ? "Creating…" : "Create token"}
        </button>
      </form>

      <h2>Account</h2>
      <div className="card" style={{ maxWidth: 360 }}>
        <div className="label">Email</div>
        <div>{user.email}</div>
      </div>
    </div>
  );
}
