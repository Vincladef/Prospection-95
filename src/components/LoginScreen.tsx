import { FormEvent, useState } from "react";
import { authClient } from "../lib/auth";

type Mode = "sign-in" | "sign-up";

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name: name || email });
      if (result.error) throw new Error(result.error.message || "Authentification refusée");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentification impossible");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-desktop">
      <section className="win-window login-window" aria-labelledby="login-title">
        <header className="win-titlebar">
          <span>✉</span>
          <strong id="login-title">Prospection 95 — Connexion</strong>
          <span className="window-controls" aria-hidden="true">▁ □ ×</span>
        </header>
        <div className="login-body">
          <div className="login-logo" aria-hidden="true">✉</div>
          <div>
            <h1>Prospection 95</h1>
            <p>Application privée de gestion de prospection.</p>
          </div>
        </div>
        <form className="win-form login-form" onSubmit={submit}>
          {mode === "sign-up" ? (
            <label>
              <span>Nom</span>
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
            </label>
          ) : null}
          <label>
            <span>Adresse administrateur</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            <span>Mot de passe</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={10}
              required
            />
          </label>
          {message ? <div className="win-alert error" role="alert">⚠ {message}</div> : null}
          <div className="dialog-actions">
            <button className="win-button primary" type="submit" disabled={pending}>
              {pending ? "Connexion…" : mode === "sign-in" ? "Se connecter" : "Créer le compte"}
            </button>
            <button
              className="win-button"
              type="button"
              onClick={() => {
                setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
                setMessage(null);
              }}
            >
              {mode === "sign-in" ? "Première connexion" : "J’ai déjà un compte"}
            </button>
          </div>
        </form>
        <footer className="login-footnote">
          L’API autorise uniquement l’adresse administrateur configurée côté serveur.
        </footer>
      </section>
    </main>
  );
}
