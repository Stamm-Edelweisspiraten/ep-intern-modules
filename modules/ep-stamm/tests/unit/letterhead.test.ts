import { describe, expect, it } from 'vitest';
import { letterGeometry, type PdfLayoutData, type PdfTemplate } from '$lib/sdk/server';
import stamm from '$modules/ep-stamm/module';
import { FOOTER_TEXT_LINES, STAMM_TEMPLATES, stammHead } from '$modules/ep-stamm/letterhead';
import { STAMM_SETTING_DEFAULTS } from '$modules/ep-stamm/defaults';

const data: PdfLayoutData = {
	title: 'Einladung',
	organization: { name: 'Neutraler Name', address: '', email: '', phone: '' },
	logoDataUrl: null,
	headerText: '',
	footerText: 'Neutrale Fußzeile',
	accentColor: '#2563eb',
	createdAt: new Date('2026-01-01'),
	locale: 'de-DE'
};

const byId = (id: string): PdfTemplate => STAMM_TEMPLATES.find((t) => t.id === id)!;

describe('Stammesprofil: Briefvorlagen', () => {
	it('ersetzt genau die drei Core-Vorlagen', () => {
		expect(STAMM_TEMPLATES.map((t) => t.id)).toEqual(['brief', 'briefkopf', 'briefkopf-quer']);
		expect(stamm.pdfTemplates).toBe(STAMM_TEMPLATES);
		expect(byId('brief').label).toBe('Stamm-Brief (mit Adressfeld)');
		expect(byId('briefkopf-quer').page?.orientation).toBe('landscape');
	});

	it('Briefkopf: Lilie, dreizeiliger Name, Wappen an den bisherigen Stellen', () => {
		const html = stammHead(letterGeometry('portrait'));
		expect(html).toContain('Christliche<br/>Pfadfinderschaft<br/>Deutschlands e.V.');
		expect(html.match(/src="data:image\/png/g)).toHaveLength(2);
		const hoch = byId('briefkopf').overlay!(data, { only: 'briefkopf' });
		expect(hoch).toContain('data-part="briefkopf"');
		expect(hoch).toContain('left:13mm;top:10.8mm;width:13.5mm;height:16.8mm');
		expect(hoch).toContain('left:176.7mm;top:10.9mm;width:20.6mm;height:30.5mm');
		expect(hoch).toContain('left:30.5mm;top:18.8mm');
		// Kopf aus dem Modul, nicht der neutrale Name
		expect(hoch).not.toContain('Neutraler Name');
		const quer = byId('briefkopf-quer').overlay!(data, { only: 'briefkopf' });
		expect(quer).toContain('left:263.7mm;top:10.9mm');
	});

	it('Fußzeile: Vereinsnachweis hochkant zweizeilig, quer als ein Absatz', () => {
		const hoch = byId('brief').overlay!(data, { only: 'fusszeile' });
		expect(hoch).toContain(FOOTER_TEXT_LINES.join('<br/>'));
		expect(hoch).toContain('Vereinsregister Heilbad Heiligenstadt unter Nr. 400532');
		expect(hoch).toContain('width:160mm');
		expect(hoch).not.toContain('Neutrale Fußzeile');
		const quer = byId('briefkopf-quer').overlay!(data, { only: 'fusszeile' });
		expect(quer).toContain(FOOTER_TEXT_LINES.join(' '));
		expect(quer).not.toContain('<br');
	});

	it('Brief: Adressfeld und Falzmarken bleiben vom Core', () => {
		const html = byId('brief').overlay!(data, { recipient: ['Erika Muster'] });
		expect(html).toContain('data-part="adressfeld"');
		expect(html).toContain('data-part="falzmarken"');
		expect(html).toContain('Erika Muster');
		expect(byId('brief').parts?.map((p) => p.id)).toEqual([
			'briefkopf',
			'falzmarken',
			'adressfeld',
			'fusszeile'
		]);
		expect(byId('brief').parts?.[0]?.description).toBe('Lilie, Vereinsname und Wappen');
	});
});

describe('Stammesprofil: Mail-Kopf, Logo, Vorgaben', () => {
	it('Mail-Kopf mit Lilie, Name und Wappen', () => {
		expect(stamm.mailBranding?.title).toBe('Christliche\nPfadfinderschaft\nDeutschlands e.V.');
		expect(stamm.mailBranding?.mark?.alt).toBe('Pfadfinder-Lilie');
		expect(stamm.mailBranding?.mark?.dataUrl).toMatch(/^data:image\/png;base64,/);
		expect(stamm.mailBranding?.emblem?.alt).toBe('Wappen');
	});

	it('Wappen als Logo (PNG, quadratisch)', () => {
		expect(stamm.brandingLogo).toMatch(/^data:image\/png;base64,/);
	});

	it('bisherige Standardwerte von EP Intern', () => {
		expect(STAMM_SETTING_DEFAULTS).toMatchObject({
			'core.system.name': 'EP Intern',
			'core.org.everyoneLabel': 'Stamm',
			'core.system.locale': 'de',
			'core.ai.style.greeting': 'Gut Pfad!'
		});
		expect(String(STAMM_SETTING_DEFAULTS['core.mail.footerText'])).toContain('Nr. 400532');
		expect(stamm.manifest.permissions).toEqual([]);
		expect(stamm.manifest.navigation).toEqual([]);
	});
});
