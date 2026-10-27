/**
 * Bereiche des Moduls Material (eigene Routen) und wer sie sieht. Rein – genutzt von `MaterialNav`
 * und Tests.
 */
import { BASE_PATH, PERMISSIONS } from '../schemas';

export type MaterialArea = 'borrow' | 'mine' | 'scan' | 'stock' | 'handout' | 'labels';

export interface AreaDef {
	area: MaterialArea;
	label: string;
	href: string;
	/** Eines der Rechte genügt */
	anyOf: string[];
	/** Auf dem Handy in der Leiste unten */
	phone: boolean;
}

export const AREAS: AreaDef[] = [
	{ area: 'borrow', label: 'Ausleihen', href: BASE_PATH, anyOf: [PERMISSIONS.view], phone: true },
	{
		area: 'mine',
		label: 'Meine Reservierungen',
		href: `${BASE_PATH}/meine`,
		anyOf: [PERMISSIONS.reserve],
		phone: true
	},
	{
		area: 'scan',
		label: 'Scannen',
		href: `${BASE_PATH}/scan`,
		anyOf: [PERMISSIONS.view],
		phone: true
	},
	{
		area: 'stock',
		label: 'Lager',
		href: `${BASE_PATH}/lager`,
		anyOf: [PERMISSIONS.view],
		phone: true
	},
	{
		area: 'handout',
		label: 'Ausgabe & Rückgabe',
		href: `${BASE_PATH}/ausgabe`,
		anyOf: [PERMISSIONS.reservations],
		phone: true
	},
	{
		area: 'labels',
		label: 'Etiketten',
		href: `${BASE_PATH}/etiketten`,
		anyOf: [PERMISSIONS.labels, PERMISSIONS.manage],
		phone: false
	}
];

/** Sichtbare Bereiche für diese Rechte (Reihenfolge fest) */
export function visibleAreas(permissions: readonly string[]): AreaDef[] {
	const set = new Set(permissions);
	return AREAS.filter((a) => a.anyOf.some((p) => set.has(p)));
}

/** Aktiver Bereich zu einem Pfad (`/modules/material/lager?…` → `stock`) */
export function areaForPath(pathname: string): MaterialArea {
	const rest = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : '';
	const seg = rest.split('/').filter(Boolean)[0] ?? '';
	if (seg === 'meine' || seg === 'reservierung') return 'mine';
	if (seg === 'scan') return 'scan';
	if (seg === 'lager') return 'stock';
	if (seg === 'ausgabe') return 'handout';
	if (seg === 'etiketten' || seg === 'labels') return 'labels';
	return 'borrow';
}
