// Sammelaktionen der Kassen-Tabellen: nacheinander über die bestehenden Einzel-Endpoints.
import { toast } from 'svelte-sonner';
import { apiFetch } from '$lib/sdk/client';
import type { InvoiceSummary } from '../schemas';
import { BASE, errorMessage, openApiFile } from './helpers';

export interface BulkFailure {
	/** Anzeigename (Empfänger*in, Rechnungsnummer …) */
	name: string;
	message: string;
}

export interface BulkOutcome {
	ok: number;
	failed: BulkFailure[];
}

/** Führt `run` je Eintrag nacheinander aus; Fehler werden gesammelt, nie abgebrochen. */
export async function runSequential<T>(
	items: T[],
	nameOf: (item: T) => string,
	run: (item: T) => Promise<string | null | void>,
	onprogress?: (done: number, total: number) => void
): Promise<BulkOutcome> {
	const out: BulkOutcome = { ok: 0, failed: [] };
	let done = 0;
	onprogress?.(0, items.length);
	for (const item of items) {
		try {
			const problem = await run(item);
			if (problem) out.failed.push({ name: nameOf(item), message: problem });
			else out.ok++;
		} catch (e) {
			out.failed.push({ name: nameOf(item), message: errorMessage(e, 'Fehlgeschlagen') });
		}
		done++;
		onprogress?.(done, items.length);
	}
	return out;
}

/** Ergebnis als Toast: Erfolg zählen, Fehler je Eintrag nennen. */
export function toastOutcome(
	outcome: BulkOutcome,
	text: { ok: (n: number) => string; failed: (n: number) => string },
	id?: string | number
): void {
	if (outcome.ok > 0) toast.success(text.ok(outcome.ok), { id });
	if (outcome.failed.length) {
		const shown = outcome.failed.slice(0, 8).map((f) => `${f.name}: ${f.message}`);
		if (outcome.failed.length > 8) shown.push(`… und ${outcome.failed.length - 8} weitere`);
		toast.error(text.failed(outcome.failed.length), {
			id: outcome.ok > 0 ? undefined : id,
			description: shown.join(' · '),
			duration: 20000
		});
	}
	if (!outcome.ok && !outcome.failed.length && id !== undefined) toast.dismiss(id);
}

/** Erinnerungen für mehrere Rechnungen (je Rechnung `POST /invoices/:id/remind`). */
export async function remindInvoices(invoices: InvoiceSummary[]): Promise<BulkOutcome> {
	const id = toast.loading(`Sendet Erinnerungen … 0 von ${invoices.length}`);
	let mails = 0;
	const outcome = await runSequential(
		invoices,
		(i) => i.number,
		async (i) => {
			const r = await apiFetch<{ invoices: number; mailsSent: number; withoutAddress: number }>(
				`${BASE}/invoices/${i.id}/remind`,
				{ method: 'POST' }
			);
			mails += r.mailsSent;
			if (r.invoices) return null;
			return r.withoutAddress ? 'keine E-Mail-Adresse hinterlegt' : 'nicht gesendet';
		},
		(done, total) => toast.loading(`Sendet Erinnerungen … ${done} von ${total}`, { id })
	);
	toastOutcome(
		outcome,
		{
			ok: (n) =>
				`${n} ${n === 1 ? 'Erinnerung' : 'Erinnerungen'} gesendet (${mails} ${mails === 1 ? 'Mail' : 'Mails'})`,
			failed: (n) => `${n} ${n === 1 ? 'Erinnerung' : 'Erinnerungen'} nicht gesendet`
		},
		id
	);
	return outcome;
}

/** Sammelrechnung (PDF) je Zahler; eine wird geöffnet, mehrere werden heruntergeladen. */
export async function openStatements(payers: { id: string; name: string }[]): Promise<void> {
	const single = payers.length === 1;
	const outcome = await runSequential(
		payers,
		(p) => p.name,
		async (p) => {
			await openApiFile(`${BASE}/payers/${p.id}/statement.pdf`, !single);
		}
	);
	if (single && !outcome.failed.length) return;
	toastOutcome(outcome, {
		ok: (n) => `${n} ${n === 1 ? 'Sammelrechnung' : 'Sammelrechnungen'} heruntergeladen`,
		failed: (n) => `${n} ${n === 1 ? 'Sammelrechnung' : 'Sammelrechnungen'} nicht erstellt`
	});
}
