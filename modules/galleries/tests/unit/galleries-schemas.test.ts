import { describe, expect, it } from 'vitest';
import {
	coverInput,
	galleryInput,
	IMAGE_VARIANTS,
	imageBulkInput,
	imageUpdateInput,
	imageUrl,
	listQuery,
	MAX_BULK,
	MAX_EVENTS_PER_GALLERY,
	MAX_SHARES,
	variantParams,
	websiteListQuery,
	websiteVariantParams,
	WEBSITE_VARIANTS
} from '$modules/galleries/schemas';

const uuid = () => crypto.randomUUID();

function paths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
	expect(result.success).toBe(false);
	return result.error!.issues.map((i) => i.path);
}

describe('galleryInput', () => {
	it('setzt Standardwerte und trimmt', () => {
		const r = galleryInput.parse({ title: '  Sommerlager  ' });
		expect(r).toEqual({
			title: 'Sommerlager',
			description: null,
			visibility: 'private',
			shares: [],
			eventIds: []
		});
	});

	it('eventIds: dedupliziert (Reihenfolge bleibt), höchstens 20, gültige IDs', () => {
		const a = uuid();
		const b = uuid();
		expect(galleryInput.parse({ title: 'x', eventIds: [a, b, a] }).eventIds).toEqual([a, b]);
		expect(MAX_EVENTS_PER_GALLERY).toBe(20);
		const ids = Array.from({ length: 21 }, () => uuid());
		expect(galleryInput.safeParse({ title: 'x', eventIds: ids.slice(0, 20) }).success).toBe(true);
		expect(paths(galleryInput.safeParse({ title: 'x', eventIds: ids }))).toContainEqual([
			'eventIds'
		]);
		expect(paths(galleryInput.safeParse({ title: 'x', eventIds: ['ok-1', 'a*b'] }))).toContainEqual(
			['eventIds', 1]
		);
		expect(galleryInput.safeParse({ title: 'x', eventIds: [''] }).success).toBe(false);
	});

	it('verlangt einen Titel (auch nach dem Trimmen)', () => {
		expect(paths(galleryInput.safeParse({}))).toContainEqual(['title']);
		expect(paths(galleryInput.safeParse({ title: '   ' }))).toContainEqual(['title']);
	});

	it('Grenzen für Titel (200) und Beschreibung (5000)', () => {
		expect(galleryInput.safeParse({ title: 'a'.repeat(200) }).success).toBe(true);
		expect(paths(galleryInput.safeParse({ title: 'a'.repeat(201) }))).toContainEqual(['title']);
		expect(galleryInput.safeParse({ title: 'x', description: 'b'.repeat(5000) }).success).toBe(
			true
		);
		expect(
			paths(galleryInput.safeParse({ title: 'x', description: 'b'.repeat(5001) }))
		).toContainEqual(['description']);
	});

	it('leere Beschreibung wird null, Text wird getrimmt', () => {
		expect(galleryInput.parse({ title: 'x', description: '   ' }).description).toBeNull();
		expect(galleryInput.parse({ title: 'x', description: null }).description).toBeNull();
		expect(galleryInput.parse({ title: 'x', description: ' Hallo ' }).description).toBe('Hallo');
	});

	it('Sichtbarkeit nur private|public', () => {
		expect(galleryInput.parse({ title: 'x', visibility: 'public' }).visibility).toBe('public');
		expect(paths(galleryInput.safeParse({ title: 'x', visibility: 'intern' }))).toContainEqual([
			'visibility'
		]);
	});

	it('ist strikt (unbekannte Felder, auch in Freigaben)', () => {
		expect(galleryInput.safeParse({ title: 'x', ownerId: 'u1' }).success).toBe(false);
		expect(
			galleryInput.safeParse({
				title: 'x',
				shares: [{ type: 'user', id: 'u1', level: 'read', extra: 1 }]
			}).success
		).toBe(false);
	});

	it('akzeptiert gültige Freigaben aller Typen', () => {
		const shares = [
			{ type: 'everyone', id: '*', level: 'read' },
			{ type: 'group', id: 'g-1', level: 'edit' },
			{ type: 'role', id: 'r_1', level: 'read' },
			{ type: 'user', id: 'U1', level: 'edit' },
			{ type: 'member', id: uuid(), level: 'read' }
		];
		expect(galleryInput.parse({ title: 'x', shares }).shares).toEqual(shares);
	});

	it('lehnt unbekannte Typen, Stufen und IDs ab', () => {
		const bad = [
			{ type: 'team', id: 'a', level: 'read' },
			{ type: 'user', id: 'a', level: 'admin' },
			{ type: 'user', id: 'a b', level: 'read' },
			{ type: 'user', id: '', level: 'read' },
			{ type: 'user', id: 'a'.repeat(65), level: 'read' }
		];
		for (const s of bad) {
			expect(galleryInput.safeParse({ title: 'x', shares: [s] }).success, JSON.stringify(s)).toBe(
				false
			);
		}
	});

	it('doppelte Freigabe -> Pfad shares,i,id (auch bei anderer Stufe)', () => {
		const r = galleryInput.safeParse({
			title: 'x',
			shares: [
				{ type: 'user', id: 'u1', level: 'read' },
				{ type: 'group', id: 'u1', level: 'read' },
				{ type: 'user', id: 'u1', level: 'edit' }
			]
		});
		expect(paths(r)).toEqual([['shares', 2, 'id']]);
	});

	it('everyone nur mit *', () => {
		const r = galleryInput.safeParse({
			title: 'x',
			shares: [
				{ type: 'user', id: '*', level: 'read' },
				{ type: 'everyone', id: 'stamm', level: 'read' }
			]
		});
		expect(paths(r)).toEqual([['shares', 1, 'id']]);
	});

	it(`höchstens ${MAX_SHARES} Freigaben`, () => {
		const mk = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ type: 'user', id: `u${i}`, level: 'read' }));
		expect(MAX_SHARES).toBe(200);
		expect(galleryInput.safeParse({ title: 'x', shares: mk(200) }).success).toBe(true);
		expect(paths(galleryInput.safeParse({ title: 'x', shares: mk(201) }))).toContainEqual([
			'shares'
		]);
	});
});

describe('coverInput', () => {
	it('uuid oder null', () => {
		const id = uuid();
		expect(coverInput.parse({ imageId: id })).toEqual({ imageId: id });
		expect(coverInput.parse({ imageId: null })).toEqual({ imageId: null });
	});

	it('lehnt fehlend, ungültig und Zusatzfelder ab', () => {
		expect(coverInput.safeParse({}).success).toBe(false);
		expect(paths(coverInput.safeParse({ imageId: 'abc' }))).toContainEqual(['imageId']);
		expect(coverInput.safeParse({ imageId: null, x: 1 }).success).toBe(false);
	});
});

describe('imageUpdateInput', () => {
	it('Standardwerte, leere Beschreibung -> null', () => {
		expect(imageUpdateInput.parse({})).toEqual({ description: null });
		expect(imageUpdateInput.parse({ description: '  ' }).description).toBeNull();
		expect(imageUpdateInput.parse({ description: ' Lagerfeuer ' }).description).toBe('Lagerfeuer');
	});

	it('Beschreibung höchstens 2000 Zeichen', () => {
		expect(imageUpdateInput.safeParse({ description: 'a'.repeat(2000) }).success).toBe(true);
		expect(paths(imageUpdateInput.safeParse({ description: 'a'.repeat(2001) }))).toContainEqual([
			'description'
		]);
	});

	it('ist strikt (Termine hängen an der Galerie, nicht am Bild)', () => {
		expect(imageUpdateInput.safeParse({ position: 3 }).success).toBe(false);
		expect(imageUpdateInput.safeParse({ eventIds: [] }).success).toBe(false);
	});
});

describe('imageBulkInput', () => {
	it('delete ist gültig', () => {
		const id = uuid();
		expect(imageBulkInput.parse({ action: 'delete', ids: [id] })).toEqual({
			action: 'delete',
			ids: [id]
		});
	});

	it('ids 1..200, dedupliziert, nur uuid', () => {
		const id = uuid();
		expect(imageBulkInput.parse({ action: 'delete', ids: [id, id] }).ids).toEqual([id]);
		expect(paths(imageBulkInput.safeParse({ action: 'delete', ids: [] }))).toContainEqual(['ids']);
		const many = Array.from({ length: MAX_BULK + 1 }, () => uuid());
		expect(imageBulkInput.safeParse({ action: 'delete', ids: many.slice(0, 200) }).success).toBe(
			true
		);
		expect(paths(imageBulkInput.safeParse({ action: 'delete', ids: many }))).toContainEqual([
			'ids'
		]);
		expect(paths(imageBulkInput.safeParse({ action: 'delete', ids: ['x'] }))).toContainEqual([
			'ids',
			0
		]);
	});

	it('nur delete, keine Termin-Aktionen, unbekannte Felder abgelehnt', () => {
		for (const action of ['add-events', 'remove-events', 'move']) {
			expect(imageBulkInput.safeParse({ action, ids: [uuid()] }).success, action).toBe(false);
		}
		expect(
			imageBulkInput.safeParse({ action: 'delete', ids: [uuid()], eventIds: ['e'] }).success
		).toBe(false);
		expect(imageBulkInput.safeParse({ action: 'delete', ids: [uuid()], x: 1 }).success).toBe(false);
	});
});

describe('Abfragen', () => {
	it('listQuery: Standard, Coercion, Grenzen', () => {
		expect(listQuery.parse({})).toEqual({ limit: 50, offset: 0 });
		expect(listQuery.parse({ limit: '1', offset: '0' })).toMatchObject({ limit: 1, offset: 0 });
		expect(listQuery.parse({ limit: '200' }).limit).toBe(200);
		expect(listQuery.safeParse({ limit: '0' }).success).toBe(false);
		expect(listQuery.safeParse({ limit: '201' }).success).toBe(false);
		expect(listQuery.safeParse({ limit: '1.5' }).success).toBe(false);
		expect(listQuery.safeParse({ offset: '-1' }).success).toBe(false);
		expect(listQuery.parse({ search: '  wald ' }).search).toBe('wald');
		expect(listQuery.safeParse({ search: 'a'.repeat(101) }).success).toBe(false);
		expect(listQuery.safeParse({ visibility: 'public' }).success).toBe(true);
		expect(listQuery.safeParse({ visibility: 'x' }).success).toBe(false);
		expect(listQuery.safeParse({ eventId: 'a b' }).success).toBe(false);
	});

	it('websiteListQuery: Standard, Coercion, Grenzen', () => {
		expect(websiteListQuery.parse({})).toEqual({ limit: 50, offset: 0 });
		expect(websiteListQuery.parse({ limit: '200', offset: '10' })).toEqual({
			limit: 200,
			offset: 10
		});
		expect(websiteListQuery.safeParse({ limit: '0' }).success).toBe(false);
		expect(websiteListQuery.safeParse({ limit: '201' }).success).toBe(false);
		expect(websiteListQuery.safeParse({ limit: 'abc' }).success).toBe(false);
		expect(websiteListQuery.parse({ eventId: 'e1' })).toEqual({
			eventId: 'e1',
			limit: 50,
			offset: 0
		});
		expect(websiteListQuery.safeParse({ eventId: 'a b' }).success).toBe(false);
	});
});

describe('Varianten', () => {
	it('Konstanten', () => {
		expect([...IMAGE_VARIANTS]).toEqual(['thumb', 'web', 'full']);
		expect([...WEBSITE_VARIANTS]).toEqual(['thumb', 'web']);
	});

	it('variantParams erlaubt full, websiteVariantParams nicht', () => {
		const base = { id: uuid(), imageId: uuid() };
		for (const v of IMAGE_VARIANTS) {
			expect(variantParams.safeParse({ ...base, variant: v }).success).toBe(true);
		}
		expect(websiteVariantParams.safeParse({ ...base, variant: 'thumb' }).success).toBe(true);
		expect(websiteVariantParams.safeParse({ ...base, variant: 'web' }).success).toBe(true);
		expect(websiteVariantParams.safeParse({ ...base, variant: 'full' }).success).toBe(false);
		expect(variantParams.safeParse({ ...base, variant: 'original' }).success).toBe(false);
		expect(variantParams.safeParse({ ...base, id: 'x', variant: 'web' }).success).toBe(false);
		expect(variantParams.safeParse({ ...base, imageId: 'x', variant: 'web' }).success).toBe(false);
	});

	it('imageUrl', () => {
		expect(imageUrl('g1', 'i1', 'thumb')).toBe(
			'/api/v1/modules/galleries/galleries/g1/images/i1/thumb'
		);
	});
});
