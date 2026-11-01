/**
 * Stammesprofil gegen den Core: Vorlagen, Einstellungs-Vorgaben, Mail-Kopf und Logo wirken nur, solange das
 * Modul aktiv ist; gespeicherte Einstellungen gewinnen; alte Vorlagen-IDs (`stamm-brief` …) bleiben gültig.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminContext,
	brandIcon,
	brandLogo,
	brandingState,
	core,
	describeTemplates,
	disableModule,
	enableModule,
	getSetting,
	invalidateModuleStateCache,
	loadMailLayoutOptions,
	logoUrl,
	registerCoreApi,
	registerModule,
	renderMailLayout,
	resolveTemplate,
	syncModules,
	useTestDatabase
} from '$testing';
import type { RequestContext } from '$lib/sdk/types';
import stamm from '$modules/ep-stamm/module';
import { STAMM_TEMPLATES } from '$modules/ep-stamm/letterhead';

const ADMIN = 'stamm-admin@example.test';
const PW = 'correct-horse-battery';
let close: () => Promise<void>;
let admin: RequestContext;

async function setActive(active: boolean) {
	if (active) await enableModule(admin, 'ep-stamm');
	else await disableModule(admin, 'ep-stamm');
	invalidateModuleStateCache();
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(stamm);
	await syncModules();
	admin = await adminContext(ADMIN, PW);
});
afterAll(async () => close());

describe('Stammesprofil inaktiv: neutraler Core', () => {
	it('Core-Vorlagen, neutrale Einstellungen, neutraler Mail-Kopf, kein Logo', async () => {
		const brief = await resolveTemplate('brief');
		expect(brief?.moduleId).toBeNull();
		expect((await resolveTemplate('stamm-brief'))?.template).toBe(brief?.template);
		expect(await getSetting('core.system.name')).toBe('Kalypzo Atrium');
		expect(await getSetting('core.org.everyoneLabel')).toBe('');
		expect(await getSetting('core.ai.style.greeting')).toBe('Viele Grüße');
		const mail = renderMailLayout({ text: 'Hallo' }, await loadMailLayoutOptions());
		expect(mail.html).not.toMatch(/Pfadfinder/);
		expect(mail.attachments).toEqual([]);
		const state = await brandingState();
		expect(state.moduleLogo).toBeNull();
		expect(logoUrl(state)).toBeNull();
		expect(await brandIcon('icon-192.png', state)).toBeNull();
	});
});

describe('Stammesprofil aktiv: bisheriges Aussehen von EP Intern', () => {
	beforeAll(() => setActive(true));

	it('Vorlagen des Moduls ersetzen die Core-Vorlagen (auch unter alter ID)', async () => {
		for (const [id, alias] of [
			['brief', 'stamm-brief'],
			['briefkopf', 'stamm-briefkopf'],
			['briefkopf-quer', 'stamm-briefkopf-quer']
		] as const) {
			const r = await resolveTemplate(alias);
			expect(r?.moduleId).toBe('ep-stamm');
			expect(r?.template).toBe(STAMM_TEMPLATES.find((t) => t.id === id));
		}
		const all = await describeTemplates();
		const brief = all.find((t) => t.id === 'brief')!;
		expect(brief.origin).toEqual({
			type: 'module',
			moduleId: 'ep-stamm',
			moduleName: 'Stammesprofil'
		});
		expect(brief.replacesCore).toBe(true);
		expect(all.filter((t) => t.id === 'brief')).toHaveLength(1);
		expect(core.pdf.listTemplates().some((t) => t.id === 'briefkopf')).toBe(true);
	});

	it('Einstellungs-Vorgaben, gespeicherte Werte gewinnen', async () => {
		expect(await getSetting('core.system.name')).toBe('EP Intern');
		expect(await getSetting('core.org.everyoneLabel')).toBe('Stamm');
		expect(await getSetting('core.ai.style.greeting')).toBe('Gut Pfad!');
		expect(String(await getSetting('core.mail.footerText'))).toContain('Nr. 400532');
		await core.settings.set(admin, 'core.system.name', 'Eigener Name');
		expect(await getSetting('core.system.name')).toBe('Eigener Name');
		await core.settings.setMany(admin, { 'core.system.name': null });
		expect(await getSetting('core.system.name')).toBe('EP Intern');
	});

	it('Mail-Kopf mit Lilie, Name und Wappen', async () => {
		const options = await loadMailLayoutOptions();
		const mail = renderMailLayout({ text: 'Hallo' }, options);
		expect(mail.html).toContain('Christliche<br/>Pfadfinderschaft<br/>Deutschlands e.V.');
		expect(mail.html).toContain('alt="Pfadfinder-Lilie"');
		expect(mail.html).toContain('alt="Wappen"');
		expect(mail.attachments).toHaveLength(2);
		expect(mail.text).toContain(
			'--\nChristliche Pfadfinderschaft Deutschlands e.V.\nDie Christliche'
		);
	});

	it('Wappen als Logo und App-Icons, solange kein Logo hochgeladen ist', async () => {
		const state = await brandingState();
		expect(state.logoId).toBeNull();
		expect(state.moduleLogo?.moduleId).toBe('ep-stamm');
		expect(logoUrl(state)).toMatch(/^\/branding\/logo\.png\?v=m/);
		const logo = await brandLogo(state);
		expect(Buffer.from(logo!).subarray(1, 4).toString()).toBe('PNG');
		const icon = await brandIcon('icon-192.png', state);
		expect(icon).toBeInstanceOf(Uint8Array);
	});

	it('nach dem Deaktivieren wieder neutral', async () => {
		await setActive(false);
		expect((await resolveTemplate('brief'))?.moduleId).toBeNull();
		expect(await getSetting('core.system.name')).toBe('Kalypzo Atrium');
		expect((await brandingState()).moduleLogo).toBeNull();
	});
});
