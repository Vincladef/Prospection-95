import { describe, expect, it } from "vitest";
import { normalizeImport } from "../importer.mts";

describe("V53 CSV import", () => {
  it("maps the real CSV headers and excludes URLs from email candidates", () => {
    const csvText = [
      'Cible,Prospect,Site internet,Contact ou lien d\'envoi,Statut,Date/heure dernier envoi,ID Gmail,Étape,Objet personnalisé,Message personnalisé,R1 (j+3),R2 (+7 jours),R3 (+7 jours),R4 (+14 jours),R5 (+14 jours),Clé contact,Nb même contact,Dans blacklist,Déjà contacté,Contrôle anti-doublon',
      'Campagne A,Alpha,https://alpha.test,alpha@example.com,Envoyé,21/10/2026 13:45:00,,,Objet,Bonjour,R1,R2,R3,R4,R5,k1,1,non,oui,OK',
      'Campagne A,Beta,https://beta.test,https://beta.test/contact,En attente...,,,,Objet 2,Bonjour 2,,,,,,k2,1,oui,non,OK',
    ].join("\n");
    const result = normalizeImport({ csvText });
    expect(result.summary.rows).toBe(2);
    expect(result.summary.validEmails).toBe(1);
    expect(result.summary.nonEmailContacts).toBe(1);
    expect(result.rows[1].email).toBeNull();
    expect(result.rows[1].blacklisted).toBe(true);
    expect(result.rows[0].alreadyContacted).toBe(true);
    expect(result.rows[0].lastSentAt).toBe("2026-10-21T11:45:00.000Z");
    expect(result.rows[0].raw.date_heure_dernier_envoi).toBe("21/10/2026 13:45:00");
  });
});
