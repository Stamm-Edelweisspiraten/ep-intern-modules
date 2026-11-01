/**
 * Vorgaben für globale Einstellungen, solange das Modul aktiv ist und nichts gespeichert wurde
 * (`ModuleDefinition.settingDefaults`) – die bisherigen Standardwerte von EP Intern.
 */
export const STAMM_SETTING_DEFAULTS: Record<string, unknown> = {
	'core.system.name': 'EP Intern',
	'core.org.everyoneLabel': 'Stamm',
	'core.system.locale': 'de',
	'core.mail.footerText':
		'Die Christliche Pfadfinderschaft Deutschland ist Mitglied der AEJ (Arbeitsgemeinschaft der Evangelischen Jugend in Deutschland e.V.), anerkannt nach §75 SGB VIII und in das Vereinsregister Heilbad Heiligenstadt unter Nr. 400532 eingetragen.',
	'core.ai.style.tone':
		'freundlich, locker und klar, wie ein Pfadfinderstamm mit Kindern und Eltern spricht',
	'core.ai.style.greeting': 'Gut Pfad!',
	'core.ai.style.context':
		'ein evangelischer Pfadfinderstamm; Texte für Kinder, Jugendliche, Eltern und Leitungen'
};
