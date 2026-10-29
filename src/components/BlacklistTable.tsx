import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BlacklistPage } from "../types";

export function BlacklistTable({ query }: { query: string }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<BlacklistPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError(null);
    // Debounce search and cancel both pending and in-flight requests on changes.
    const timer = window.setTimeout(() => {
      void api.blacklist(query, page, controller.signal).then((data) => {
        if (!controller.signal.aborted) setResult(data);
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Chargement impossible.");
      });
    }, query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, page, attempt]);

  if (error) return <div className="win-alert" role="alert">{error} <button className="win-button" onClick={() => setAttempt((value) => value + 1)}>Réessayer</button></div>;
  if (!result) return <div className="empty-state" role="status">Chargement de la blacklist…</div>;

  return <>
    <p role="status">{result.total} entrée(s) dans la blacklist{query ? " pour cette recherche" : ""}.</p>
    <div className="directory-table-wrap">
      <table className="directory-table">
        <thead><tr><th>Contact / domaine</th><th>Type</th><th>Situation</th><th>Motif</th><th>Ajout</th></tr></thead>
        <tbody>{result.entries.map((entry) => <tr key={entry.id}>
          <td><strong>{entry.matchValue}</strong></td>
          <td>{entry.matchType === "domain" ? "Domaine entier" : "Adresse email"}</td>
          <td><span className="directory-tag danger">Blacklist</span></td>
          <td>{entry.reason || "—"}</td>
          <td>{new Date(entry.createdAt).toLocaleString("fr-FR")}</td>
        </tr>)}</tbody>
      </table>
      {!result.entries.length ? <div className="empty-state">Aucune entrée dans la blacklist pour ces filtres.</div> : null}
    </div>
    {result.total > 50 || page > 1 ? <nav className="toolbar" aria-label="Pagination de la blacklist">
      <button className="win-button" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Précédent</button>
      <span>Page {page}</span>
      <button className="win-button" disabled={page * 50 >= result.total} onClick={() => setPage((value) => value + 1)}>Suivant</button>
    </nav> : null}
  </>;
}
