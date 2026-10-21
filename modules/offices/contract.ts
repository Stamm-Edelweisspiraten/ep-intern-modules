/**
 * Dienst des Moduls `offices` für andere Module (über `provides`, Aufruf per
 * `core.modules.useOptional<OfficesService>('offices', '<modul>')` – das aufrufende Modul führt
 * `offices` in `optionalDependencies`). Keine Server-Imports.
 */
import type { RequestContext } from '$lib/sdk/types';

/** Ein Ereignis für die Inhaber*innen eines Vorlagen-Amts (`manifest.offices`). */
export interface OfficeNotification {
	/** Modul, das das Amt als Vorlage deklariert (z. B. `treasury`) */
	module: string;
	/** Schlüssel der Amt-Vorlage (z. B. `kasse`) */
	office: string;
	/** Schlüssel der Benachrichtigung aus der Vorlage (z. B. `payable-created`) */
	event: string;
	/** Kurze Überschrift des Ereignisses (eine Zeile, ≤ 150 Zeichen) */
	subject: string;
	/** Klartext (≤ 4000 Zeichen); keine sensiblen Daten wie IBAN */
	text: string;
	/** Relativer App-Pfad, z. B. `/modules/treasury?tab=payables` (wird zur absoluten URL) */
	link?: string;
}

export interface NotifyResult {
	/** Versendete Mails (je Person eine, gebündelt) */
	sent: number;
	/** In die Tageszusammenfassung gelegte Ereignisse */
	queued: number;
	/** Übersprungen: Amt fehlt/unbesetzt, Modus „aus“, Konto inaktiv, Versandfehler */
	skipped: number;
}

/** Amt des Kontos mit seinen Funktions-Adressen (für Absender des Moduls `messages`) */
export interface OwnOfficeEmails {
	officeId: string;
	officeName: string;
	emails: { label: string | null; email: string }[];
}

export interface OfficesService {
	/** Ämter, bei denen `ctx.userId` Inhaber*in ist, mit Adressen (nur Ämter mit mindestens einer Adresse) */
	listOwnOfficeEmails(ctx: RequestContext): Promise<OwnOfficeEmails[]>;
	/**
	 * Benachrichtigt die Inhaber*innen der Vorlagen-Ämter. Mehrere Ereignisse eines Aufrufs gehen je
	 * Person als **eine** Mail raus (Modus „sofort“) bzw. in die Tageszusammenfassung („täglich“).
	 * Wirft nie (Fehler werden geloggt). Nicht innerhalb einer Modul-Transaktion aufrufen.
	 */
	notify(ctx: RequestContext, items: OfficeNotification[]): Promise<NotifyResult>;
}
