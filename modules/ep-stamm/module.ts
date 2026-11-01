import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { STAMM_TEMPLATES } from './letterhead';
import { STAMM_SETTING_DEFAULTS } from './defaults';
import mailLilie from './assets/mail-lilie.png?inline';
import mailWappen from './assets/mail-wappen.png?inline';
import appIcon from './assets/icons/icon-512.png?inline';

/**
 * Stammesprofil der Edelweißpiraten: liefert dem neutralen Core (Kalypzo Atrium) das bisherige Aussehen von
 * EP Intern – Briefkopf, Mail-Kopf, Wappen als Logo/App-Icon und Vorgaben für Systemname, „Stamm“, Sprache,
 * Mail-Fußzeile und Schreibstil der KI. Ohne eigene Seiten, Rechte oder Daten.
 */
export default defineModule({
	package: pkg,
	manifest: {
		...manifestFromPackage(pkg),
		permissions: [],
		navigation: []
	},
	settingDefaults: STAMM_SETTING_DEFAULTS,
	pdfTemplates: STAMM_TEMPLATES,
	mailBranding: {
		title: 'Christliche\nPfadfinderschaft\nDeutschlands e.V.',
		mark: { dataUrl: mailLilie, alt: 'Pfadfinder-Lilie' },
		emblem: { dataUrl: mailWappen, alt: 'Wappen' }
	},
	brandingLogo: appIcon
});
