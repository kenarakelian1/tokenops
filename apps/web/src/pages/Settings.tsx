import { useState, type FormEvent } from "react";
import {
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

      <h2>Account</h2>
      <div className="card" style={{ maxWidth: 360 }}>
        <div className="label">Email</div>
        <div>{user.email}</div>
      </div>
    </div>
  );
}
