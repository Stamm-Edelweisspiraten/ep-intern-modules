import { describe, expect, it } from 'vitest';
import { suggestPayable, type PayableCandidate } from '$modules/treasury/logic';

const c = (
	id: string,
	recipientName: string,
	openCents: number,
	ibanLast4: string | null = null
): PayableCandidate => ({ id, recipientName, description: 'x', openCents, ibanLast4 });

const list = [
	c('zelt', 'Zeltplatz Waldblick GmbH', 12000, '2051'),
	c('bus', 'Busreisen Nord', 12000),
	c('anna', 'Anna Schmidt', 2350, '9999'),
	c('done', 'Erledigt AG', 0)
];

describe('suggestPayable', () => {
	it('IBAN-Ende + Betrag → sicher', () => {
		expect(
			suggestPayable(
				{ amountCents: -12000, counterparty: null, purpose: null, ibanLast4: '2051' },
				list
			)
		).toMatchObject({ payableId: 'zelt', confidence: 'high' });
	});

	it('IBAN passt, Betrag nicht → wahrscheinlich', () => {
		expect(
			suggestPayable(
				{ amountCents: -2000, counterparty: null, purpose: null, ibanLast4: '9999' },
				list
			)
		).toMatchObject({ payableId: 'anna', confidence: 'medium' });
	});

	it('Name (zwei Wörter, Umlaute/Groß-Klein egal) + Betrag → sicher', () => {
		expect(
			suggestPayable(
				{ amountCents: -12000, counterparty: 'ZELTPLATZ WALDBLICK', purpose: 'RE 4711' },
				list
			)
		).toMatchObject({ payableId: 'zelt', confidence: 'high' });
	});

	it('ein einzelnes Namenswort reicht bei mehrteiligen Namen nicht', () => {
		// "Nord" allein trifft "Busreisen Nord" nicht; Betrag 12000 ist doppelt → kein Vorschlag
		expect(
			suggestPayable({ amountCents: -12000, counterparty: 'Nord', purpose: null }, list)
		).toBeNull();
	});

	it('nur der Betrag, eindeutig → unsicher', () => {
		expect(
			suggestPayable({ amountCents: -2350, counterparty: 'Unbekannt', purpose: null }, list)
		).toMatchObject({ payableId: 'anna', confidence: 'low' });
	});

	it('bezahlte Auszahlungen und Betrag 0 werden ignoriert', () => {
		expect(
			suggestPayable({ amountCents: -1, counterparty: 'Erledigt AG', purpose: null }, list)
		).toBeNull();
		expect(
			suggestPayable({ amountCents: 0, counterparty: 'Anna Schmidt', purpose: null }, list)
		).toBeNull();
		expect(suggestPayable({ amountCents: -100, counterparty: 'x', purpose: null }, [])).toBeNull();
	});
});
