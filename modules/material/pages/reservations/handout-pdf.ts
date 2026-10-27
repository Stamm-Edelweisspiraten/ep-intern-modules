/**
 * Ausgabeliste einer Reservierung als PDF herunterladen (`GET /reservations/:id/handout.pdf`,
 * nach Lagerort sortiert, zum Abhaken).
 */
import { downloadPdf } from '$lib/components/layout/download';
import { API } from '../helpers';

/** Dateiname, falls der Server keinen mitschickt */
function fallbackName(title: string): string {
	const base = title
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.slice(0, 60);
	return `Ausgabeliste${base ? `-${base}` : ''}.pdf`;
}

export function downloadHandoutPdf(id: string, title: string): Promise<void> {
	return downloadPdf(
		`/api/v1${API}/reservations/${id}/handout.pdf`,
		{ method: 'GET' },
		fallbackName(title)
	);
}
