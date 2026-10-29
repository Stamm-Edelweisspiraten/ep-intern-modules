/**
 * Übersicht „Zu erledigen“ für Kämmerer*innen (Rechte wie die Kachel `orders:manage`): Bestellungen
 * ausgeben (`orders.order.manage`), Fehlmengen, offene Einkäufe und unbezahlte Lieferantenrechnungen
 * (`orders.stock.manage`). Je Kennzahl höchstens eine Zeile, nur wenn es etwas zu tun gibt.
 */
import type { ModuleDashboardSources } from '$lib/sdk/server';
import type { DashboardTodo } from '$lib/sdk/types/dashboard';
import { loadOrdersOverview } from './orders.endpoints';
import { canManage } from './orders.service';
import { BASE_PATH, PERMISSIONS } from './schemas';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const ordersDashboard: ModuleDashboardSources = {
	todos: {
		permission: PERMISSIONS.view,
		anyPermission: [PERMISSIONS.manage, PERMISSIONS.stock],
		run: async (ctx, { limit }) => {
			const manage = canManage(ctx);
			const stock = ctx.permissions.has(PERMISSIONS.stock);
			if (!manage && !stock) return [];
			const o = await loadOrdersOverview(ctx);
			const todos: DashboardTodo[] = [];
			if (manage && o.openOrders > 0) {
				todos.push({
					id: 'handout',
					title: `${plural(o.openOrders, 'Bestellung', 'Bestellungen')} ausgeben`,
					detail: o.openItems ? `${o.openItems} Stück aus dem Lager` : undefined,
					severity: 'due',
					action: { label: 'Ausgeben', href: `${BASE_PATH}?tab=bestellungen` }
				});
			}
			if (stock && o.deficitVariants > 0) {
				todos.push({
					id: 'deficit',
					title: 'Fehlmengen nachbestellen',
					detail: `${plural(o.deficitVariants, 'Artikel bzw. Größe', 'Artikel bzw. Größen')} unter Bedarf`,
					severity: 'due',
					action: { label: 'Lager', href: `${BASE_PATH}?tab=lager` }
				});
			}
			if (stock && o.treasuryActive && o.unpaidSupplierInvoices > 0) {
				todos.push({
					id: 'supplier-unpaid',
					title: `${plural(
						o.unpaidSupplierInvoices,
						'Lieferantenrechnung',
						'Lieferantenrechnungen'
					)} bezahlen`,
					detail: 'Auszahlung in der Kasse noch offen',
					severity: 'due',
					action: { label: 'Einkauf', href: `${BASE_PATH}?tab=einkauf` }
				});
			}
			if (stock && o.openSupplierOrders > 0) {
				todos.push({
					id: 'supplier-open',
					title: `${plural(o.openSupplierOrders, 'Einkauf', 'Einkäufe')} offen`,
					detail: 'Lieferung erfassen, sobald die Ware da ist',
					severity: 'info',
					action: { label: 'Einkauf', href: `${BASE_PATH}?tab=einkauf` }
				});
			}
			return todos.slice(0, limit);
		}
	}
};
