import { FormEvent, useState } from "react";
import { authClient } from "../lib/auth";

type Mode = "sign-in" | "sign-up" | "forgot-password" | "reset-password";

function initialMode(): Mode {
  return new URLSearchParams(window.location.search).has("token") ? "reset-password" : "sign-in";
}

function readableAuthError(error: unknown) {
  const fallback = error instanceof Error ? error.message : "Authentification impossible";
  const normalized = fallback.toLowerCase();

  if (normalized.includes("invalid email or password") || normalized.includes("invalid password")) {
    return "Adresse ou mot de passe incorrect.";
  }
  if (normalized.includes("user already exists") || normalized.includes("already exists")) {
    return "Ce compte existe déjà. Utilisez « J’ai déjà un compte » ou réinitialisez le mot de passe.";
  }
  if (normalized.includes("password") && normalized.includes("short")) {
    return "Le mot de passe doit contenir au moins 10 caractères.";
  }

  return fallback;
}

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"error" | "info">("error");

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setMessage(null);
    setPassword("");
    setPasswordConfirmation("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setMessageKind("error");
    try {
      if (mode === "forgot-password") {
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}${window.location.pathname}`,
        });
        if (result.error) throw new Error(result.error.message || "Réinitialisation refusée");
        setMode("sign-in");
        setMessageKind("info");
        setMessage("Un lien de réinitialisation vient d’être envoyé. Vérifiez aussi les courriers indésirables.");
        return;
      }

      if (mode === "reset-password") {
        if (password !== passwordConfirmation) throw new Error("Les deux mots de passe ne correspondent pas.");
        const token = new URLSearchParams(window.location.search).get("token");
        if (!token || token === "INVALID_TOKEN") throw new Error("Ce lien de réinitialisation est invalide ou expiré.");
        const result = await authClient.resetPassword({ newPassword: password, token });
        if (result.error) throw new Error(result.error.message || "Réinitialisation refusée");
        window.history.replaceState({}, "", window.location.pathname);
        setMode("sign-in");
        setPassword("");
        setPasswordConfirmation("");
        setMessageKind("info");
        setMessage("Mot de passe modifié. Vous pouvez maintenant vous connecter.");
        return;
      }

      if (mode === "sign-up") {
        const signUp = await authClient.signUp.email({ email, password, name: name || email });
        if (signUp.error) throw new Error(signUp.error.message || "Création du compte refusée");

        // Neon Auth ne crée pas toujours une session lors de l'inscription.
        // On connecte donc explicitement le nouveau compte avant d'ouvrir l'application.
        const signIn = await authClient.signIn.email({ email, password });
        if (signIn.error) throw new Error(signIn.error.message || "Compte créé, mais connexion refusée");
      } else {
        const signIn = await authClient.signIn.email({ email, password });
        if (signIn.error) throw new Error(signIn.error.message || "Authentification refusée");
      }

      window.location.reload();
    } catch (error) {
      setMessage(readableAuthError(error));
    } finally {
      setPending(false);
    }
  }

  const title =
    mode === "sign-up"
      ? "Créer le compte administrateur"
      : mode === "forgot-password"
        ? "Réinitialiser le mot de passe"
        : mode === "reset-password"
          ? "Choisir un nouveau mot de passe"
          : "Se connecter";

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
            <p>{title}</p>
          </div>
        </div>
        <form className="win-form login-form" onSubmit={submit}>
          {mode === "sign-up" ? (
            <label>
              <span>Nom</span>
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
            </label>
          ) : null}
          {mode !== "reset-password" ? (
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
          ) : null}
          {mode !== "forgot-password" ? (
            <label>
              <span>{mode === "reset-password" ? "Nouveau mot de passe" : "Mot de passe"}</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                minLength={10}
                required
              />
            </label>
          ) : null}
          {mode === "reset-password" ? (
            <label>
              <span>Confirmer le mot de passe</span>
              <input
                type="password"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
                autoComplete="new-password"
                minLength={10}
                required
              />
            </label>
          ) : null}
          {message ? <div className={`win-alert ${messageKind}`} role={messageKind === "error" ? "alert" : "status"}>⚠ {message}</div> : null}
          <div className="dialog-actions">
            <button className="win-button primary" type="submit" disabled={pending}>
              {pending
                ? "Veuillez patienter…"
                : mode === "sign-up"
                  ? "Créer le compte"
                  : mode === "forgot-password"
                    ? "Envoyer le lien"
                    : mode === "reset-password"
                      ? "Enregistrer"
                      : "Se connecter"}
            </button>
            {mode === "sign-in" ? (
              <>
                <button className="win-button" type="button" onClick={() => changeMode("forgot-password")}>Mot de passe oublié</button>
                <button className="win-button" type="button" onClick={() => changeMode("sign-up")}>Première connexion</button>
              </>
            ) : (
              <button className="win-button" type="button" onClick={() => changeMode("sign-in")}>Retour à la connexion</button>
            )}
          </div>
        </form>
        <footer className="login-footnote">
          L’API autorise uniquement l’adresse administrateur configurée côté serveur.
        </footer>
      </section>
    </main>
  );
}
