/** Häufige Länder (ISO-3166-Alpha-2); weitere Codes aus bestehenden Daten werden bei Bedarf ergänzt. */
const COMMON = [
	'DE',
	'AT',
	'CH',
	'LU',
	'NL',
	'BE',
	'FR',
	'IT',
	'ES',
	'PT',
	'DK',
	'SE',
	'NO',
	'FI',
	'IS',
	'IE',
	'GB',
	'PL',
	'CZ',
	'SK',
	'HU',
	'SI',
	'HR',
	'RO',
	'BG',
	'GR',
	'LT',
	'LV',
	'EE',
	'TR',
	'UA',
	'RU',
	'US',
	'CA',
	'MX',
	'BR',
	'AR',
	'AU',
	'NZ',
	'JP',
	'CN',
	'IN',
	'IL',
	'ZA'
];

export function countryLabel(code: string): string {
	try {
		return new Intl.DisplayNames('de', { type: 'region' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** Länderliste für `SelectField` (Deutschland zuerst, Rest alphabetisch); `current` wird ergänzt, falls unbekannt. */
export function countryOptions(current?: string): { value: string; label: string }[] {
	const codes = new Set(COMMON);
	if (current && /^[A-Z]{2}$/.test(current)) codes.add(current);
	const rest = [...codes]
		.filter((c) => c !== 'DE')
		.map((c) => ({ value: c, label: countryLabel(c) }))
		.sort((a, b) => a.label.localeCompare(b.label, 'de'));
	return [{ value: 'DE', label: countryLabel('DE') }, ...rest];
}
