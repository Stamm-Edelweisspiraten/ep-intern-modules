/** IBAN-Hilfen der Kasse – gemeinsame Implementierung in `$lib/sdk/iban` (#70). */
import { ibanLast } from '$lib/sdk/iban';

export { formatIban, isValidIban, maskIbanTail as maskIban, normalizeIban } from '$lib/sdk/iban';

/** Letzte 4 Stellen (Speicherung neben der verschlüsselten IBAN) */
export const ibanLast4 = (input: string) => ibanLast(input, 4);
