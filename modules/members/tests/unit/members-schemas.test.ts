import { describe, expect, it } from 'vitest';
import {
	ageFromBirthDate,
	groupInput,
	isRealDate,
	memberInput,
	normalizeHexColor
} from '$modules/members/schemas';

const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_B = '9b2f6c0e-1a4d-4c7e-8f31-2d5a7b9c1e44';

describe('ageFromBirthDate', () => {
	const today = new Date(2026, 5, 15); // 15.06.2026 (lokal)
	it('Geburtstag heute zählt bereits', () => {
		expect(ageFromBirthDate('2013-06-15', today)).toBe(13);
	});
	it('Geburtstag morgen noch nicht', () => {
		expect(ageFromBirthDate('2013-06-16', today)).toBe(12);
	});
	it('Geburtstag gestern bereits', () => {
		expect(ageFromBirthDate('2013-06-14', today)).toBe(13);
	});
	it('Schaltjahr: 29.02. wird am 28.02. noch nicht, am 01.03. gezählt', () => {
		expect(ageFromBirthDate('2012-02-29', new Date(2026, 1, 28))).toBe(13);
		expect(ageFromBirthDate('2012-02-29', new Date(2026, 2, 1))).toBe(14);
		expect(ageFromBirthDate('2012-02-29', new Date(2028, 1, 29))).toBe(16);
	});
	it('ungültiges Format -> null', () => {
		expect(ageFromBirthDate('15.06.2013', today)).toBeNull();
	});
});

describe('isRealDate', () => {
	it('prüft Kalenderdaten', () => {
		expect(isRealDate('2024-02-29')).toBe(true);
		expect(isRealDate('2025-02-29')).toBe(false);
		expect(isRealDate('2025-13-01')).toBe(false);
		expect(isRealDate('2025-04-31')).toBe(false);
		expect(isRealDate('abc')).toBe(false);
	});
});

describe('normalizeHexColor', () => {
	it('normalisiert', () => {
		expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
		expect(normalizeHexColor('#2F855A')).toBe('#2f855a');
		expect(normalizeHexColor('2f855a')).toBeNull();
		expect(normalizeHexColor('#12')).toBeNull();
	});
});

const validMember = {
	firstName: 'Anna',
	lastName: 'Muster',
	birthDate: '2012-05-01',
	street: 'Hauptstr. 1',
	postalCode: '12345',
	city: 'Ort',
	country: 'DE',
	phones: [{ name: 'Mutter', value: '+49 171 1234567' }],
	emails: [{ name: null, value: 'Anna@Example.com' }],
	stage: 'woelfling',
	groupIds: [UUID_A]
};

describe('memberInput: Mitgliedschaft', () => {
	it('Standardwerte: keine Daten, kein Zweitmitglied, alle Ebenen', () => {
		const r = memberInput.parse(validMember);
		expect(r.entryDate).toBeNull();
		expect(r.exitDate).toBeNull();
		expect(r.secondaryMember).toBe(false);
		expect(r.feeLevels).toEqual(['stamm', 'gau', 'landesmark', 'bund']);
	});
	it('leere Datumsfelder werden zu null', () => {
		const r = memberInput.parse({ ...validMember, entryDate: '', exitDate: '' });
		expect(r.entryDate).toBeNull();
		expect(r.exitDate).toBeNull();
	});
	it('Austritt am Eintrittstag ist erlaubt, davor nicht', () => {
		expect(
			memberInput.safeParse({ ...validMember, entryDate: '2020-01-01', exitDate: '2020-01-01' })
				.success
		).toBe(true);
		const r = memberInput.safeParse({
			...validMember,
			entryDate: '2020-01-02',
			exitDate: '2020-01-01'
		});
		expect(r.success).toBe(false);
		expect(r.error?.issues.some((i) => i.path[0] === 'exitDate')).toBe(true);
	});
	it('lehnt unechte Daten ab', () => {
		expect(memberInput.safeParse({ ...validMember, entryDate: '2020-02-30' }).success).toBe(false);
		expect(memberInput.safeParse({ ...validMember, exitDate: '01.01.2020' }).success).toBe(false);
	});
	it('Zweitmitglied braucht mindestens eine Ebene', () => {
		const r = memberInput.safeParse({ ...validMember, secondaryMember: true, feeLevels: [] });
		expect(r.success).toBe(false);
		expect(r.error?.issues.some((i) => i.path[0] === 'feeLevels')).toBe(true);
	});
	it('ordnet Ebenen fest und entfernt Duplikate', () => {
		const r = memberInput.parse({
			...validMember,
			secondaryMember: true,
			feeLevels: ['bund', 'stamm', 'bund']
		});
		expect(r.feeLevels).toEqual(['stamm', 'bund']);
	});
	it('lehnt unbekannte Ebenen ab', () => {
		expect(
			memberInput.safeParse({ ...validMember, secondaryMember: true, feeLevels: ['kreis'] }).success
		).toBe(false);
	});
});

describe('memberInput', () => {
	it('akzeptiert gültige Eingaben und normalisiert', () => {
		const r = memberInput.safeParse(validMember);
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.emails[0]?.value).toBe('anna@example.com');
			expect(r.data.phones[0]?.name).toBe('Mutter');
			expect(r.data.scoutName).toBeNull();
		}
	});
	it('lehnt ungültige E-Mail ab', () => {
		const r = memberInput.safeParse({
			...validMember,
			emails: [{ name: null, value: 'kein-mail' }]
		});
		expect(r.success).toBe(false);
	});
	it('lehnt ungültige Telefonnummer ab', () => {
		for (const value of ['abc', '12', '++49 123 456', '1234567890123456789'])
			expect(
				memberInput.safeParse({ ...validMember, phones: [{ name: null, value }] }).success
			).toBe(false);
	});
	it('lehnt doppelte Kontakte ab', () => {
		const dupMail = memberInput.safeParse({
			...validMember,
			emails: [
				{ name: null, value: 'a@example.com' },
				{ name: 'Vater', value: 'A@example.com' }
			]
		});
		expect(dupMail.success).toBe(false);
		const dupPhone = memberInput.safeParse({
			...validMember,
			phones: [
				{ name: null, value: '0171 1234567' },
				{ name: null, value: '0171-1234567' }
			]
		});
		expect(dupPhone.success).toBe(false);
	});
	it('lehnt Geburtsdatum in der Zukunft, unechte und unplausible Daten ab', () => {
		const future = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
		expect(memberInput.safeParse({ ...validMember, birthDate: future }).success).toBe(false);
		expect(memberInput.safeParse({ ...validMember, birthDate: '2025-02-30' }).success).toBe(false);
		expect(memberInput.safeParse({ ...validMember, birthDate: '1800-01-01' }).success).toBe(false);
	});
	it('lehnt ungültige Gruppen-ID und Stand ab', () => {
		expect(memberInput.safeParse({ ...validMember, groupIds: ['x'] }).success).toBe(false);
		expect(memberInput.safeParse({ ...validMember, stage: 'chef' }).success).toBe(false);
	});
});

describe('groupInput', () => {
	const base = { name: 'Adler', type: 'sippe', leaderIds: [UUID_A, UUID_B] };
	it('normalisiert die Farbe', () => {
		const r = groupInput.safeParse({ ...base, color: '#ABC', meetingWeekday: 3 });
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.color).toBe('#aabbcc');
			expect(r.data.meetingWeekday).toBe(3);
		}
	});
	it('Farbe und Wochentag sind optional', () => {
		const r = groupInput.safeParse(base);
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.color).toBeNull();
			expect(r.data.meetingWeekday).toBeNull();
		}
	});
	it('lehnt ungültigen Wochentag, Farbe und fehlende Leiter ab', () => {
		expect(groupInput.safeParse({ ...base, meetingWeekday: 0 }).success).toBe(false);
		expect(groupInput.safeParse({ ...base, meetingWeekday: 8 }).success).toBe(false);
		expect(groupInput.safeParse({ ...base, meetingWeekday: 1.5 }).success).toBe(false);
		expect(groupInput.safeParse({ ...base, color: 'rot' }).success).toBe(false);
		expect(groupInput.safeParse({ ...base, leaderIds: [] }).success).toBe(false);
	});
});
