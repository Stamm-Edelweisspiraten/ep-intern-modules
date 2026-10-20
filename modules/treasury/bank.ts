/** Bankverbindungen (Zahler, Auszahlungen, Import): IBAN nur verschlüsselt + HMAC für den Abgleich. */
import { core } from '$lib/sdk/server';
import { ibanLast4, isValidIban, normalizeIban } from './iban';
import { MODULE_ID } from './schemas';

const crypto = () => core.crypto.forModule(MODULE_ID);

export interface StoredIban {
	enc: string | null;
	last4: string | null;
	hash: string | null;
}

/** `undefined` = unverändert, `''` = entfernen, sonst verschlüsseln (Eingabe ist bereits geprüft) */
export function storeIban(iban: string | undefined): StoredIban | undefined {
	if (iban === undefined) return undefined;
	if (!iban) return { enc: null, last4: null, hash: null };
	const n = normalizeIban(iban);
	return { enc: crypto().encrypt(n), last4: ibanLast4(n), hash: crypto().hash(n) };
}

/** HMAC einer (ggf. aus dem Import stammenden) IBAN; `null`, wenn ungültig */
export function ibanHash(raw: string | null | undefined): { hash: string; last4: string } | null {
	if (!raw) return null;
	const n = normalizeIban(raw);
	if (!isValidIban(n)) return null;
	return { hash: crypto().hash(n), last4: ibanLast4(n) };
}

export function decryptIban(enc: unknown): string | null {
	return typeof enc === 'string' && enc ? crypto().decrypt(enc) : null;
}
