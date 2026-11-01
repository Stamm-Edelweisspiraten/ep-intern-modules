import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { planSubsidyApplications } from '$modules/actions/subsidy-application';
import { fillSubsidyApplicationPdf } from '$modules/actions/subsidy-application-pdf';
import type { EligibilityParticipant } from '$modules/actions/subsidy-eligibility';
import type { LeaderGender } from '$modules/actions/schemas';

// Aktionsstart 2026-07-10: Kind = 2017 (9 J.), Jugendliche*r = 2011 (15 J.), Team = 2004 (22 J.)
const START = '2026-07-10';
let seq = 0;
function p(over: Partial<EligibilityParticipant> = {}): EligibilityParticipant {
	seq++;
	return {
		id: `p${seq}`,
		name: `Person ${String(seq).padStart(3, '0')}`,
		role: 'participant',
		birthDate: '2011-05-01',
		bremenResident: true,
		juleica: false,
		subsidyEligible: null,
		...over
	};
}
const kids = (n: number) => Array.from({ length: n }, () => p({ birthDate: '2017-05-01' }));
const youth = (n: number) => Array.from({ length: n }, () => p());
const team = (n: number, over: Partial<EligibilityParticipant> = {}) =>
	Array.from({ length: n }, () => p({ role: 'team', birthDate: '2004-01-01', ...over }));

function plan(
	participants: EligibilityParticipant[],
	genders: [EligibilityParticipant, LeaderGender][] = [],
	over: { freizeitType?: 'kids' | 'youth'; nights?: number } = {}
) {
	return planSubsidyApplications({
		participants,
		startsOn: START,
		nights: over.nights ?? 6,
		lodgingType: 'external',
		konfi: false,
		freizeitType: over.freizeitType ?? 'youth',
		genders: new Map(genders.map(([x, g]) => [x.id, g]))
	});
}

describe('planSubsidyApplications', () => {
	it('ohne Leitungspaar: ein Antrag mit Warnung', () => {
		const r = plan(youth(3));
		expect(r.forms).toHaveLength(1);
		expect(r.forms[0]!.youth).toHaveLength(3);
		expect(r.warnings.join(' ')).toMatch(/weibliche und\/oder männliche Leitung/);
	});

	it('20 Kinder passen auf einen Antrag, 21 brauchen zwei', () => {
		const [f, m] = team(2);
		const one = plan(
			[...kids(20), f!, m!],
			[
				[f!, 'female'],
				[m!, 'male']
			]
		);
		expect(one.neededForms).toBe(1);
		expect(one.unassigned.filter((u) => u.reason === 'children-full')).toHaveLength(0);

		const [f2, m2] = team(2);
		const two = plan(
			[...kids(21), f2!, m2!],
			[
				[f2!, 'female'],
				[m2!, 'male']
			]
		);
		expect(two.neededForms).toBe(2);
		// nur ein Leitungspaar → nur ein Antrag, ein Kind bleibt übrig
		expect(two.forms).toHaveLength(1);
		expect(two.unassigned.filter((u) => u.reason === 'children-full')).toHaveLength(1);
		expect(two.warnings.join(' ')).toMatch(/Nötig wären 2 Anträge/);
	});

	it('Team 12–27 zählt in der Jugendliste seines Antrags mit', () => {
		const t = team(4);
		const r = plan(
			[...youth(30), ...t],
			[
				[t[0]!, 'female'],
				[t[1]!, 'male'],
				[t[2]!, 'female'],
				[t[3]!, 'male']
			]
		);
		// 30 + 4 Team = 34 → 2 Anträge, je 2 Team + 15 Jugendliche
		expect(r.neededForms).toBe(2);
		expect(r.forms).toHaveLength(2);
		for (const f of r.forms) {
			expect(f.femaleLeaders).toHaveLength(1);
			expect(f.maleLeaders).toHaveLength(1);
			expect(f.youth).toHaveLength(17);
			const ids = f.youth.map((y) => y.participantId);
			expect(ids).toContain(f.femaleLeaders[0]!.participantId);
			expect(ids).toContain(f.maleLeaders[0]!.participantId);
		}
		expect(r.unassigned).toHaveLength(0);
	});

	it('3 Anträge nötig, 2 Leitungspaare → 2 Anträge und Überlauf', () => {
		const t = team(4);
		const r = plan(
			[...kids(50), ...t],
			[
				[t[0]!, 'female'],
				[t[1]!, 'male'],
				[t[2]!, 'female'],
				[t[3]!, 'male']
			],
			{ freizeitType: 'kids' }
		);
		expect(r.neededForms).toBe(3);
		expect(r.forms).toHaveLength(2);
		expect(r.forms.map((f) => f.children.length)).toEqual([20, 20]);
		expect(r.unassigned.filter((u) => u.reason === 'children-full')).toHaveLength(10);
	});

	it('Taschengeld: 1 je 7 Jugendliche, höchstens 5 Zeilen, Juleica zuerst', () => {
		const t = team(8);
		t[5]!.juleica = true;
		const r = plan(
			[...youth(12), ...t],
			[
				[t[0]!, 'female'],
				[t[1]!, 'male']
			]
		);
		// 12 + 8 Team = 20 Jugendliche → Grenze 2
		const f = r.forms[0]!;
		expect(f.youth).toHaveLength(20);
		expect(f.allowance).toHaveLength(2);
		expect(f.allowance[0]!.participantId).toBe(t[5]!.id);
		expect(f.allowance[0]!.rateCents).toBe(1500);
		expect(f.allowance[0]!.totalCents).toBe(1500 * 6);
		expect(f.allowance[1]!.rateCents).toBe(1000);
		expect(r.unassigned.filter((u) => u.reason === 'allowance-limit')).toHaveLength(6);

		const many = team(10);
		const big = plan(
			[...kids(20), ...many],
			[
				[many[0]!, 'female'],
				[many[1]!, 'male']
			],
			{ freizeitType: 'kids' }
		);
		// 20 Kinder + 10 Team auf der Jugendliste = 30 Personen → Grenze 6, höchstens 5 Zeilen
		expect(big.forms[0]!.allowance).toHaveLength(5);
	});

	it('Taschengeld-Grenze zählt alle auf dem Antrag, auch die Leitungen selbst', () => {
		// Kinderfreizeit: 3 Kinder + 2 Leitungen (22 J., Bremen) = 5 → genau 1 Taschengeld
		const [f, m] = team(2);
		const pair: [EligibilityParticipant, LeaderGender][] = [
			[f!, 'female'],
			[m!, 'male']
		];
		const one = plan([...kids(3), f!, m!], pair, { freizeitType: 'kids' });
		expect(one.forms[0]!.children).toHaveLength(3);
		expect(one.forms[0]!.youth).toHaveLength(2);
		expect(one.forms[0]!.allowance).toHaveLength(1);
		expect(one.unassigned.filter((u) => u.reason === 'allowance-limit')).toHaveLength(1);

		// 2 Kinder + 2 Leitungen = 4 → kein Taschengeld (abgerundet)
		const none = plan([...kids(2), f!, m!], pair, { freizeitType: 'kids' });
		expect(none.forms[0]!.allowance).toHaveLength(0);

		// Jugendfreizeit: 5 Jugendliche + 2 Leitungen = 7 → 1; Kinder zählen mit (3 + 4 + 2 = 9 → 1)
		expect(plan([...youth(5), f!, m!], pair).forms[0]!.allowance).toHaveLength(1);
		expect(plan([...youth(4), f!, m!], pair).forms[0]!.allowance).toHaveLength(0);
		expect(plan([...kids(3), ...youth(2), f!, m!], pair).forms[0]!.allowance).toHaveLength(1);

		// Leitungen über 27 bzw. ohne Bremen stehen nicht auf der Liste und zählen nicht mit
		const [of, om] = team(2, { birthDate: '1990-01-01' });
		const old = plan(
			[...kids(4), of!, om!],
			[
				[of!, 'female'],
				[om!, 'male']
			],
			{ freizeitType: 'kids' }
		);
		expect(old.forms[0]!.youth).toHaveLength(0);
		expect(old.forms[0]!.allowance).toHaveLength(0);
	});

	it('Taschengeld-Grenze gilt je Antrag', () => {
		const t = team(4);
		const r = plan(
			[...youth(30), ...t],
			[
				[t[0]!, 'female'],
				[t[1]!, 'male'],
				[t[2]!, 'female'],
				[t[3]!, 'male']
			]
		);
		// 34 Personen auf 2 Anträge: je 2 Team + 15 Jugendliche = 17 → je 2 Taschengelder
		expect(r.forms.map((f) => f.youth.length)).toEqual([17, 17]);
		expect(r.forms.map((f) => f.allowance.length)).toEqual([2, 2]);
	});

	it('schließt ausdrücklich Ausgeschlossene, über 27 und ohne Bremen aus', () => {
		const [f, m] = team(2);
		const r = plan(
			[
				p({ subsidyEligible: false }),
				p({ birthDate: '1990-01-01' }),
				p({ bremenResident: false }),
				p({ bremenResident: false, subsidyEligible: true }),
				p({ birthDate: null }),
				f!,
				m!
			],
			[
				[f!, 'female'],
				[m!, 'male']
			]
		);
		const listed = r.forms[0]!.youth.map((y) => y.name);
		// 2 Team + „ohne Bremen, aber ausdrücklich berechtigt“
		expect(listed).toHaveLength(3);
		expect(r.warnings.join(' ')).toMatch(/Geburtsdatum oder der Wohnort/);
	});

	it('Zuschuss je Antrag nach Richtlinie (6 Nächte, extern)', () => {
		const [f, m] = team(2);
		const r = plan(
			[...kids(2), ...youth(1), f!, m!],
			[
				[f!, 'female'],
				[m!, 'male']
			]
		);
		// Kinder 2 × 6 × 15 € + Jugend (1 + 2 Team) × 6 × 16 € = 180 € + 288 €
		expect(r.forms[0]!.subsidyCents).toBe(18000 + 28800);
	});
});

describe('fillSubsidyApplicationPdf', () => {
	const template = readFileSync(new URL('../../assets/zuschussantrag-bek.pdf', import.meta.url));

	it('erzeugt je Antrag zwei Seiten und setzt die Texte ein', async () => {
		const t = team(4);
		const r = plan(
			[...youth(30), ...t],
			[
				[t[0]!, 'female'],
				[t[1]!, 'male'],
				[t[2]!, 'female'],
				[t[3]!, 'male']
			]
		);
		r.forms[0]!.youth[0]!.name = 'Jörg Weiß-Übel';
		const bytes = await fillSubsidyApplicationPdf(new Uint8Array(template), r.forms, {
			freizeitArt: 'Sommerlager',
			parish: 'Gemeinde Süd',
			startsOn: START,
			endsOn: '2026-07-16',
			location: 'Zeltplatz',
			topic: 'Wikinger 🛶',
			inclusion: true,
			bank: {
				holder: 'Förderverein Stamm',
				name: 'Sparkasse',
				iban: 'DE89 3704 0044 0532 0130 00',
				bic: 'COBADEFFXXX'
			}
		});
		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(4);

		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		const loaded = await pdfjs.getDocument({ data: bytes }).promise;
		const textOf = async (n: number) =>
			(await (await loaded.getPage(n)).getTextContent()).items
				.map((i) => ('str' in i ? i.str : ''))
				.join(' ');
		const front = await textOf(1);
		expect(front).toContain('Sommerlager');
		expect(front).toContain('Gemeinde Süd');
		expect(front).toContain('10.07.2026');
		expect(front).toContain('Antrag 1 von 2');
		expect(front).toContain('Förderverein Stamm');
		expect(front).toContain('Sparkasse');
		expect(front).toContain('DE89 3704 0044 0532 0130 00');
		// Zeichen außerhalb der Standardschrift werden ersetzt statt abzubrechen
		expect(front).toContain('Wikinger ?');
		expect(await textOf(2)).toContain('Jörg Weiß-Übel');
		expect(await textOf(3)).toContain('Antrag 2 von 2');
	});
});
