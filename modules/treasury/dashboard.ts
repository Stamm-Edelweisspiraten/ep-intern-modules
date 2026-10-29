/**
 * Übersicht „Zu erledigen“ der Kasse:
 * - mit `treasury.own.view`: eigene offene Rechnungen (verknüpfte Mitglieder, wie `GET /my/invoices`)
 *   mit Zahlungsdaten – Bankverbindung nur aus den Kassen-Einstellungen;
 * - mit `treasury.cash.view`: Aufgaben der Kasse (`Overview.tasks`, Texte aus `taskView`).
 * Dienste laufen außerhalb von Modul-Transaktionen (`loadMyInvoices`/`loadOverview` öffnen eigene).
 */
import type { ModuleDashboardSources, RequestContext } from '$lib/sdk/server';
import type { DashboardTodo, DashboardTodoSeverity } from '$lib/sdk/types/dashboard';
import { loadMyInvoices } from './my.endpoints';
import { taskView } from './pages/task-view';
import { loadOverview } from './reports.endpoints';
import type { OverviewTask } from './schemas';

const BASE = '/modules/treasury';

const TASK_SEVERITY: Record<OverviewTask['severity'], DashboardTodoSeverity> = {
	critical: 'overdue',
	warning: 'due',
	info: 'info'
};

/** „Mia“, „Mia und Lukas“, „Mia, Lukas und Ben“ */
function joinNames(names: string[]): string {
	if (names.length < 2) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}

async function ownInvoiceTodos(ctx: RequestContext, today: string): Promise<DashboardTodo[]> {
	const { invoices, bank } = await loadMyInvoices(ctx);
	const cash = ctx.permissions.has('treasury.cash.view');
	return invoices.map((inv) => ({
		id: `invoice:${inv.id}`,
		title: inv.occasion ? `Rechnung ${inv.occasion} bezahlen` : `Rechnung ${inv.number} bezahlen`,
		detail: [inv.number, joinNames(inv.members)].filter(Boolean).join(' · '),
		due: inv.dueDate,
		severity: inv.dueDate < today ? 'overdue' : 'due',
		amountCents: inv.openCents,
		// Ohne Kassenrecht gibt es keine Rechnungsseite – die Zahlungsdaten stehen in der Zeile
		action: {
			label: 'Bezahlen',
			href: cash ? `${BASE}/invoices/${encodeURIComponent(inv.id)}` : '/dashboard'
		},
		payment: bank
			? {
					holder: bank.holder,
					iban: bank.iban.replace(/\s+/g, ''),
					bic: bank.bic || undefined,
					amountCents: inv.openCents,
					reference: inv.purpose
				}
			: undefined
	}));
}

async function cashTaskTodos(ctx: RequestContext): Promise<DashboardTodo[]> {
	const { tasks } = await loadOverview(ctx);
	return tasks.map((t) => {
		// Betrag steht rechts in der Zeile, nicht zusätzlich im Titel
		const v = taskView({ ...t, cents: null });
		return {
			id: `task:${t.kind}`,
			title: v.title,
			detail: v.hint || undefined,
			severity: TASK_SEVERITY[t.severity],
			amountCents: t.cents ?? undefined,
			action: { label: v.action, href: v.href }
		};
	});
}

const RANK: Record<DashboardTodoSeverity, number> = { overdue: 0, due: 1, info: 2 };

export const treasuryDashboard: ModuleDashboardSources = {
	todos: {
		anyPermission: ['treasury.own.view', 'treasury.cash.view'],
		run: async (ctx, { today, limit }) => {
			const todos: DashboardTodo[] = [];
			if (ctx.permissions.has('treasury.own.view'))
				todos.push(...(await ownInvoiceTodos(ctx, today)));
			if (ctx.permissions.has('treasury.cash.view')) todos.push(...(await cashTaskTodos(ctx)));
			// Wichtigstes zuerst, damit die Begrenzung nichts Dringendes abschneidet
			return todos
				.map((t, i) => ({ t, i }))
				.sort((a, b) => RANK[a.t.severity] - RANK[b.t.severity] || a.i - b.i)
				.map(({ t }) => t)
				.slice(0, limit);
		}
	}
};
