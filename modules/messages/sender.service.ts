/**
 * Erlaubte Absender und Einstellungen. Quellen (jeweils nur für die angemeldete Person):
 * - persönlich `vorname.nachname@domain` (Einstellung `messages.domain`, Name aus dem eigenen Mitglied,
 *   sonst aus dem Kontonamen),
 * - Funktions-Adressen der eigenen Ämter (`offices`, optional),
 * - Kontakt-E-Mail der Gruppen, die die Person leitet,
 * - Stamm-Adresse (`core.organization.email`).
 * Der Server prüft beim Senden erneut, dass der gewählte Absender in dieser Liste steht.
 * Core-Aufrufe immer außerhalb einer Modul-Transaktion.
 */
import { core, errors, type RequestContext } from '$lib/sdk/server';
import type { MembersService } from '$lib/modules/members/contract';
import type { OfficesService } from '$lib/modules/offices/contract';
import { isValidDomain, normalizeAddress, personalAddress, splitFullName } from './sender';
import {
	MAX_RECIPIENTS_DEFAULT,
	MAX_RECIPIENTS_LIMIT,
	MODULE_ID,
	LAYOUTS,
	REPLY_TO_MODES,
	SETTING_KEYS,
	type MessageLayout,
	type ReplyToMode,
	type Sender,
	type SendersResponse
} from './schemas';

export interface MessageSettings {
	domain: string;
	personalEnabled: boolean;
	replyTo: ReplyToMode;
	layout: MessageLayout;
	maxRecipients: number;
}

export async function loadSettings(): Promise<MessageSettings> {
	const s = await core.settings.getMany(Object.values(SETTING_KEYS));
	const replyTo = String(s[SETTING_KEYS.replyTo] ?? '');
	const max = Number(s[SETTING_KEYS.maxRecipients]);
	return {
		domain: String(s[SETTING_KEYS.domain] ?? '')
			.trim()
			.toLowerCase(),
		personalEnabled: s[SETTING_KEYS.personalEnabled] !== false,
		replyTo: (REPLY_TO_MODES as readonly string[]).includes(replyTo)
			? (replyTo as ReplyToMode)
			: 'account',
		layout: (LAYOUTS as readonly string[]).includes(String(s[SETTING_KEYS.layout]))
			? (s[SETTING_KEYS.layout] as MessageLayout)
			: 'stamm',
		maxRecipients:
			Number.isInteger(max) && max >= 1
				? Math.min(max, MAX_RECIPIENTS_LIMIT)
				: MAX_RECIPIENTS_DEFAULT
	};
}

/** Konto-Adresse der angemeldeten Person (nur die eigene wird vom Verzeichnis geliefert) */
export async function accountEmail(ctx: RequestContext): Promise<string | null> {
	if (!ctx.userId) return null;
	const [me] = await core.users.directory(ctx, { ids: [ctx.userId], limit: 1 });
	return me?.email ? normalizeAddress(me.email) : null;
}

async function personalSender(
	ctx: RequestContext,
	settings: MessageSettings
): Promise<{ sender: Sender | null; hint: string | null }> {
	if (!settings.personalEnabled) {
		return { sender: null, hint: 'Persönliche Absenderadressen sind ausgeschaltet.' };
	}
	if (!isValidDomain(settings.domain)) {
		return {
			sender: null,
			hint: 'Für persönliche Adressen fehlt die Domain in den Einstellungen des Moduls Nachrichten.'
		};
	}
	const members = await core.modules.use<MembersService>('members', MODULE_ID);
	let name = await members.getOwnMemberName(ctx);
	if (!name && ctx.userId) {
		const [me] = await core.users.directory(ctx, { ids: [ctx.userId], limit: 1 });
		if (me) name = splitFullName(me.name);
	}
	const address = name ? personalAddress({ ...name, domain: settings.domain }) : null;
	if (!name || !address) {
		return {
			sender: null,
			hint: 'Aus deinem Namen lässt sich keine Adresse bilden (Vor- und Nachname nötig).'
		};
	}
	const display = `${name.firstName.trim().split(/\s+/)[0]} ${name.lastName}`.trim();
	return {
		sender: {
			key: 'personal',
			kind: 'personal',
			address,
			name: display,
			label: `${display} <${address}>`
		},
		hint: null
	};
}

/** Domain einer Adresse (nach dem letzten @), klein geschrieben */
const domainOf = (address: string) => address.split('@').pop()?.trim().toLowerCase() ?? '';

/**
 * Hinweis, wenn Absenderadressen eine andere Domain haben als der Mailserver (`core.smtp.from`): Dann
 * müssen SPF/DKIM/DMARC für die Absender-Domain stimmen, sonst landen Mails eher im Spam.
 */
async function deliverabilityHint(
	settings: MessageSettings,
	senders: Sender[]
): Promise<string | null> {
	const smtp = await core.settings.getMany(['core.smtp.from']);
	const smtpDomain = domainOf(String(smtp['core.smtp.from'] ?? '').replace(/^.*<|>.*$/g, ''));
	if (!smtpDomain) return null;
	const other = [...new Set(senders.map((s) => domainOf(s.address)))].filter(
		(d) => d && d !== smtpDomain
	);
	if (!other.length) return null;
	return `Absenderadressen mit der Domain ${other.join(', ')} weichen vom Mailserver (${smtpDomain}) ab. Damit die Mails nicht im Spam landen, müssen SPF, DKIM und DMARC für diese Domain eingerichtet sein und der Mailserver das Senden als diese Adressen erlauben.`;
}

/** Alle Absender, die `ctx` verwenden darf (persönlich zuerst) */
export async function listSenders(ctx: RequestContext): Promise<SendersResponse> {
	const settings = await loadSettings();
	const senders: Sender[] = [];
	const personal = await personalSender(ctx, settings);
	if (personal.sender) senders.push(personal.sender);

	const offices = await core.modules.useOptional<OfficesService>('offices', MODULE_ID);
	for (const office of (await offices?.listOwnOfficeEmails(ctx)) ?? []) {
		for (const e of office.emails) {
			senders.push({
				key: `office:${office.officeId}:${normalizeAddress(e.email)}`,
				kind: 'office',
				address: normalizeAddress(e.email),
				name: office.officeName,
				label: `${office.officeName} <${normalizeAddress(e.email)}>${e.label ? ` – ${e.label}` : ''}`
			});
		}
	}

	const members = await core.modules.use<MembersService>('members', MODULE_ID);
	for (const g of await members.listLedGroups(ctx)) {
		if (!g.email) continue;
		senders.push({
			key: `group:${g.id}`,
			kind: 'group',
			address: normalizeAddress(g.email),
			name: g.name,
			label: `${g.name} <${normalizeAddress(g.email)}>`
		});
	}

	const org = await core.settings.getMany(['core.organization.email', 'core.organization.name']);
	const stammMail = String(org['core.organization.email'] ?? '').trim();
	if (stammMail) {
		const name = String(org['core.organization.name'] ?? '').trim() || 'Stamm';
		senders.push({
			key: 'stamm',
			kind: 'stamm',
			address: normalizeAddress(stammMail),
			name,
			label: `${name} <${normalizeAddress(stammMail)}>`
		});
	}

	return {
		senders,
		accountEmail: await accountEmail(ctx),
		replyToDefault: settings.replyTo,
		personalHint: personal.hint,
		layoutDefault: settings.layout,
		deliverabilityHint: await deliverabilityHint(settings, senders)
	};
}

/** Gewählten Absender prüfen; nicht erlaubt → 403 (die Liste kommt immer frisch vom Server) */
export async function requireSender(ctx: RequestContext, key: string): Promise<Sender> {
	const { senders } = await listSenders(ctx);
	const found = senders.find((s) => s.key === key);
	if (!found) throw errors.forbidden('Diese Absenderadresse darfst du nicht verwenden');
	return found;
}
