import { SignIn } from "@clerk/react";

export function Login() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>TokenOps</h1>
        <p className="tagline">Sign in to view your usage ledger</p>
        <SignIn />
      </div>
    </div>
  );
}
