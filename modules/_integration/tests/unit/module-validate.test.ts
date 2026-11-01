import { describe, expect, it } from 'vitest';
import type { ModuleDefinition } from '$testing';
import { validateModuleReferences } from '$testing';
import actionsModule from '$modules/actions/module';
import eventsModule from '$modules/events/module';
import filesModule from '$modules/files/module';
import galleriesModule from '$modules/galleries/module';
import membersModule from '$modules/members/module';
import officesModule from '$modules/offices/module';
import ordersModule from '$modules/orders/module';
import treasuryModule from '$modules/treasury/module';
import whiteboardModule from '$modules/whiteboard/module';

const ALL: ModuleDefinition[] = [
	membersModule,
	actionsModule,
	treasuryModule,
	eventsModule,
	galleriesModule,
	officesModule,
	ordersModule,
	filesModule,
	whiteboardModule
];

function fake(over: Partial<ModuleDefinition> & { id?: string } = {}): ModuleDefinition {
	const id = over.id ?? 'demo';
	return {
		manifest: {
			id,
			name: 'Demo',
			version: '1.0.0',
			description: '',
			dependencies: [],
			permissions: [`${id}.item.view`],
			navigation: [],
			...over.manifest
		},
		...over
	} as ModuleDefinition;
}

describe('validateModuleReferences (#76, 10-10)', () => {
	it('alle echten Module sind gültig', () => {
		expect(() => validateModuleReferences(ALL)).not.toThrow();
	});

	it('meldet die gegenseitige Kopplung actions ⇄ treasury als Warnung', () => {
		const warnings = validateModuleReferences(ALL);
		expect(warnings.some((w) => w.includes('actions') && w.includes('treasury'))).toBe(true);
		// jeder Zyklus nur einmal
		expect(new Set(warnings).size).toBe(warnings.length);
	});

	it('unbekanntes Recht in defaultRoleGrants wirft', () => {
		const def = fake({ defaultRoleGrants: { Mitglied: ['demo.item.view', 'demo.item.edit'] } });
		expect(() => validateModuleReferences([def])).toThrow(/demo\.item\.edit/);
	});

	it('fremdes Recht in manifest.defaultRoleGrants wirft', () => {
		const base = fake();
		const def = fake({
			manifest: { ...base.manifest, defaultRoleGrants: { Mitglied: ['core.users.view'] } }
		});
		expect(() => validateModuleReferences([def])).toThrow(/nicht im Manifest/);
	});

	it('unbekanntes Recht in der Navigation wirft, Core- und Fremdrechte sind erlaubt', () => {
		const base = fake();
		const nav = (permission: string) =>
			fake({
				manifest: {
					...base.manifest,
					navigation: [{ label: 'Demo', path: '/modules/demo', icon: 'box', permission }]
				}
			});
		expect(() => validateModuleReferences([nav('demo.item.vew')])).toThrow(/unbekanntes Recht/);
		expect(() => validateModuleReferences([nav('core.users.view')])).not.toThrow();
		expect(() =>
			validateModuleReferences([nav('members.member.view'), membersModule])
		).not.toThrow();
	});

	it('unbekanntes Recht in search wirft', () => {
		const run = async () => [];
		expect(() =>
			validateModuleReferences([fake({ search: { permission: 'demo.nope.view', run } })])
		).toThrow(/search/);
		expect(() =>
			validateModuleReferences([
				fake({ search: { anyPermission: ['demo.item.view', 'x.y.z'], run } })
			])
		).toThrow(/x\.y\.z/);
		expect(() =>
			validateModuleReferences([fake({ search: { permission: 'demo.item.view', run } })])
		).not.toThrow();
	});

	it('ungültige Reset-Bereiche werfen', () => {
		const area = { label: 'A', description: 'B', tables: ['t'] };
		expect(() =>
			validateModuleReferences([fake({ resetAreas: [{ ...area, id: 'Alle' }] })])
		).toThrow(/Reset-Bereich-ID/);
		expect(() =>
			validateModuleReferences([
				fake({
					resetAreas: [
						{ ...area, id: 'all' },
						{ ...area, id: 'all' }
					]
				})
			])
		).toThrow(/doppelte/);
		expect(() =>
			validateModuleReferences([fake({ resetAreas: [{ ...area, id: 'all', tables: [] }] })])
		).toThrow(/löscht nichts/);
	});

	it('implies auf unbekannten Bereich eines registrierten Moduls wirft, unregistriertes Modul wird übersprungen', () => {
		const area = { id: 'all', label: 'A', description: 'B', tables: ['t'] };
		const withImplies = (target: string) =>
			fake({ resetAreas: [{ ...area, implies: [{ area: target, reason: 'x' }] }] });
		expect(() =>
			validateModuleReferences([withImplies('members:gibtsnicht'), membersModule])
		).toThrow(/unbekannten Bereich/);
		expect(() =>
			validateModuleReferences([withImplies('members:all'), membersModule])
		).not.toThrow();
		expect(() => validateModuleReferences([withImplies('fremd:all')])).not.toThrow();
		expect(() => validateModuleReferences([withImplies('ohne-doppelpunkt')])).toThrow(/erwartet/);
	});

	it('embeds: Art eindeutig und gültig, Recht muss bekannt sein', () => {
		const embed = (kind: string, permission?: string) => ({
			kind,
			label: 'Demo',
			icon: 'box',
			permission,
			search: async () => [],
			describe: async () => new Map()
		});
		expect(() =>
			validateModuleReferences([fake({ embeds: [embed('item', 'demo.item.view')] })])
		).not.toThrow();
		expect(() =>
			validateModuleReferences([fake({ embeds: [embed('item', 'demo.item.nope')] })])
		).toThrow(/unbekanntes Recht/);
		expect(() => validateModuleReferences([fake({ embeds: [embed('Item')] })])).toThrow(
			/Embed-Art/
		);
		expect(() =>
			validateModuleReferences([fake({ embeds: [embed('item'), embed('item')] })])
		).toThrow(/doppelte Embed-Art/);
	});
});
