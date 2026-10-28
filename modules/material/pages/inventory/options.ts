/**
 * Hilfen für den Reiter „Lager“: Auswahl-Optionen, Rechte, Zusammenfassungen.
 */
import { page } from '$app/state';
import { can } from '$lib/sdk/client';
import {
	CONDITIONS,
	CONDITION_LABELS,
	PERMISSIONS,
	type Category,
	type Item,
	type Location,
	type MaterialSet,
	type MaterialType
} from '../../schemas';

/** Vorbelegung beim Anlegen eines Lagerartikels */
export interface ItemPreset {
	typeId?: string | null;
	locationId?: string | null;
	setId?: string | null;
	/** Vorab gedruckter (reservierter) Code */
	code?: string | null;
}

export interface Option {
	value: string;
	label: string;
}

export const conditionOptions: Option[] = CONDITIONS.map((c) => ({
	value: c,
	label: CONDITION_LABELS[c]
}));

export const categoryOptions = (list: readonly Category[]): Option[] =>
	list.map((c) => ({ value: c.id, label: c.name }));

export const locationOptions = (list: readonly Location[]): Option[] =>
	list.map((l) => ({ value: l.id, label: l.name }));

export const setOptions = (list: readonly MaterialSet[]): Option[] =>
	list.map((s) => ({ value: s.id, label: s.name }));

export const typeOptions = (list: readonly MaterialType[]): Option[] =>
	list.map((t) => ({ value: t.id, label: t.name }));

/** Rechte der angemeldeten Person für das Lager */
export function inventoryPermissions() {
	const list = (page.data.permissions ?? []) as string[];
	const manage = can(list, PERMISSIONS.manage);
	return {
		manage,
		reserve: can(list, PERMISSIONS.reserve),
		reservations: can(list, PERMISSIONS.reservations),
		/** Etiketten drucken */
		labels: manage || can(list, PERMISSIONS.labels),
		/** Zustand melden */
		report: manage || can(list, PERMISSIONS.reserve)
	};
}

/** Lagerorte der Artikel eines Typs: „Kiste 1“, „3 Orte“ oder „–“ */
export function locationSummary(items: readonly Item[]): string {
	const names = new Set(items.map((i) => i.locationName ?? 'Ohne Ort'));
	if (names.size === 0) return '–';
	if (names.size === 1) return [...names][0]!;
	return `${names.size} Orte`;
}

/** Artikel mit Mängeln (nicht „in Ordnung“/„gebraucht“) */
export const problemCount = (items: readonly Item[]) =>
	items.filter((i) => i.condition !== 'ok' && i.condition !== 'worn').length;

/** „Kohtenbahn K1.1, K1.2 … K1.8“ als Vorschau langer Namenslisten */
export function previewNames(names: readonly string[], max = 4): string {
	if (names.length <= max) return names.join(', ');
	return `${names.slice(0, max - 1).join(', ')} … ${names[names.length - 1]}`;
}
