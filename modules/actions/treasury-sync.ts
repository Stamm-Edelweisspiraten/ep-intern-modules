/**
 * Kasse sofort nachziehen: Nach jedem erfolgreichen schreibenden Endpunkt einer Aktion
 * (Teilnehmende, Beitrag übernehmen, Aktion ändern/löschen, Abrechnung, Zwischenabrechnung,
 * Rückzahlung, Auslagen …) gleicht die Kasse GENAU diese Aktion ab (`TreasuryService.actionChanged`).
 * Läuft NACH dem Handler, also nach dessen Transaktion; ohne aktive Kasse passiert nichts.
 * Lesende Endpunkte und Vorgänge ohne Einfluss auf Rechnungen/Auszahlungen lösen nichts aus.
 */
import { core, type ApiEndpoint, type RequestContext } from '$lib/sdk/server';
import type { TreasuryService } from '$lib/modules/treasury/contract';

/** Schreibende Pfade ohne Einfluss auf die Kasse (Freigaben, Formular, Belegdateien, Kostenlink, Rückzahlungsbriefe/-links) */
const IRRELEVANT =
	/\/shares\/|\/form(\/|$)|\/receipt$|\/expense-link(\/|$)|\/expense-submissions\/[^/]+\/reject$|\/calculation$|\/refund\/letters\.pdf$|\/refund\/items\/[^/]+\/link$/;

function actionIdOf(endpoint: ApiEndpoint, params: unknown, result: unknown): string | null {
	if (endpoint.path === '/actions/import') {
		const id = (result as { id?: unknown } | null)?.id;
		return typeof id === 'string' ? id : null;
	}
	if (!endpoint.path.startsWith('/actions/:id')) return null;
	const id = (params as { id?: unknown } | null)?.id;
	return typeof id === 'string' ? id : null;
}

/** Kasse gezielt für eine Aktion abgleichen (`ctx = null` → System); wirft nie */
export async function notifyTreasury(ctx: RequestContext | null, actionId: string): Promise<void> {
	try {
		const treasury = await core.modules.useOptional<TreasuryService>('treasury', 'actions');
		await treasury?.actionChanged(ctx, actionId);
	} catch (e) {
		console.error('[actions] Abgleich mit der Kasse fehlgeschlagen:', e);
	}
}

export function withTreasurySync(endpoints: ApiEndpoint[]): ApiEndpoint[] {
	return endpoints.map((endpoint) => {
		if (endpoint.method === 'GET' || endpoint.public || IRRELEVANT.test(endpoint.path)) {
			return endpoint;
		}
		const handler = endpoint.handler;
		return {
			...endpoint,
			handler: async (args) => {
				const result = await handler(args);
				const actionId = actionIdOf(endpoint, args.params, result);
				if (actionId && !(result instanceof Response && !result.ok)) {
					await notifyTreasury(args.ctx, actionId);
				}
				return result;
			}
		} as ApiEndpoint;
	});
}
