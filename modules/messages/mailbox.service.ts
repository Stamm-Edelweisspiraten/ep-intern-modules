/**
 * Postfächer: welche gibt es (systemweit, für die Zuordnung beim Abruf und für Benachrichtigungen) und
 * welche darf die angemeldete Person lesen (je Request frisch – Ämter/Leitungen wechseln).
 *
 * Zugriff = Absenderrecht (`GET /senders`): persönliches Postfach nur die Person selbst, Amtsadressen alle
 * Inhaber*innen, Gruppenadressen alle Leitungen, Stamm-Adresse zusätzlich mit `messages.inbox.stamm`,
 * „Nicht zugeordnet“ mit `messages.inbox.manage`, zusätzliche Postfächer der Verwaltung über ihre Freigaben
 * (Stufe „Lesen“ ohne Absender). Alles setzt `messages.message.send` voraus. Weiterleitungen erscheinen im
 * Verzeichnis als weitere Adresse ihres Ziel-Postfachs (`alias: true`).
 * Core-Aufrufe nie innerhalb einer Modul-Transaktion.
 */
import { core, errors, type RequestContext } from '$lib/sdk/server';
import type { MembersService } from '$lib/modules/members/contract';
import type { OfficesService } from '$lib/modules/offices/contract';
import {
	UNASSIGNED,
	isSharedMailbox,
	kindOf,
	personalKey,
	senderKeyFor,
	type MailboxKind,
	type MailboxTarget
} from './mailbox';
import { isValidDomain, normalizeAddress, personalAddress, splitFullName } from './sender';
import { listSenders, loadSettings } from './sender.service';
import { extraDirectoryEntries, loadAliasRows, myExtraMailboxes } from './extra-mailbox.service';
import { MODULE_ID, PERM_INBOX_MANAGE, PERM_INBOX_STAMM, PERM_SEND } from './schemas';

const system = () => core.auth.systemContext(MODULE_ID);

/** Postfach mit allen Konten, die es lesen dürfen (systemweit) */
export interface MailboxEntry extends MailboxTarget {
	kind: MailboxKind;
	userIds: string[];
	/** Weiterleitung: weitere Adresse des Postfachs `key` (Name/Konten wie das Ziel) */
	alias?: true;
}

/**
 * Alle Postfächer mit Adresse und berechtigten Konten (nur aktive Konten mit `messages.message.send`).
 * Persönliche Adressen wie beim Senden: Name des eigenen Mitglieds, sonst aus dem Kontonamen.
 */
export async function loadMailboxDirectory(): Promise<MailboxEntry[]> {
	const settings = await loadSettings();
	const senders = new Set(await core.permissions.usersWith(PERM_SEND));
	const out: MailboxEntry[] = [];

	const members = await core.modules.use<MembersService>('members', MODULE_ID);
	if (settings.personalEnabled && isValidDomain(settings.domain) && senders.size) {
		const own = new Map((await members.listSelfMemberNames()).map((n) => [n.userId, n]));
		const accounts = await core.users.byIds(system(), [...senders]);
		for (const userId of senders) {
			const name = own.get(userId) ?? splitFullName(accounts.get(userId)?.name ?? '');
			const address = personalAddress({ ...name, domain: settings.domain });
			if (!address) continue;
			const display = `${name.firstName.trim().split(/\s+/)[0] ?? ''} ${name.lastName}`.trim();
			out.push({
				key: personalKey(userId),
				kind: 'personal',
				address,
				name: display,
				userIds: [userId]
			});
		}
	}

	const offices = await core.modules.useOptional<OfficesService>('offices', MODULE_ID);
	for (const office of (await offices?.listOfficeMailboxes()) ?? []) {
		const userIds = office.holderUserIds.filter((id) => senders.has(id));
		for (const e of office.emails) {
			const address = normalizeAddress(e.email);
			out.push({
				key: `office:${office.officeId}:${address}`,
				kind: 'office',
				address,
				name: office.officeName,
				userIds
			});
		}
	}

	for (const g of await members.listGroupMailboxes()) {
		out.push({
			key: `group:${g.id}`,
			kind: 'group',
			address: normalizeAddress(g.email),
			name: g.name,
			userIds: g.leaderUserIds.filter((id) => senders.has(id))
		});
	}

	const org = await core.settings.getMany(['core.organization.email', 'core.organization.name']);
	const stammMail = normalizeAddress(String(org['core.organization.email'] ?? ''));
	if (stammMail) {
		const stammUsers = await core.permissions.usersWith(PERM_INBOX_STAMM);
		out.push({
			key: 'stamm',
			kind: 'stamm',
			address: stammMail,
			name: String(org['core.organization.name'] ?? '').trim() || 'Stamm',
			userIds: stammUsers.filter((id) => senders.has(id))
		});
	}

	out.push(...(await extraDirectoryEntries()));

	// Weiterleitungen: Alias-Adresse mit Schlüssel, Name und Konten des Ziels (unbekanntes Ziel → übersprungen)
	const byKey = new Map<string, MailboxEntry>();
	for (const e of out) if (!byKey.has(e.key)) byKey.set(e.key, e);
	for (const a of await loadAliasRows()) {
		const target = byKey.get(a.targetKey);
		if (!target) continue;
		out.push({ ...target, address: a.address, alias: true });
	}
	return out;
}

/** Postfach, das die angemeldete Person lesen darf */
export interface AccessibleMailbox {
	key: string;
	kind: MailboxKind;
	address: string;
	name: string;
	shared: boolean;
	senderKey: string | null;
}

/**
 * Postfächer der angemeldeten Person (Reihenfolge: persönlich, Ämter, Gruppen, Stamm, zusätzliche,
 * Nicht zugeordnet)
 */
export async function accessibleMailboxes(ctx: RequestContext): Promise<AccessibleMailbox[]> {
	if (!ctx.userId || !core.permissions.has(ctx, PERM_SEND)) return [];
	const extras = await myExtraMailboxes(ctx);
	const { senders } = await listSenders(ctx, { extras });
	const out: AccessibleMailbox[] = [];
	for (const s of senders) {
		if (s.kind === 'extra') continue;
		if (s.kind === 'stamm' && !core.permissions.has(ctx, PERM_INBOX_STAMM)) continue;
		const key = s.kind === 'personal' ? personalKey(ctx.userId) : s.key;
		out.push({
			key,
			kind: kindOf(key),
			address: s.address,
			name: s.kind === 'personal' ? 'Persönlich' : s.name,
			shared: isSharedMailbox(key),
			senderKey: senderKeyFor(key)
		});
	}
	for (const x of extras) {
		out.push({
			key: x.key,
			kind: 'extra',
			address: x.address,
			name: x.name,
			shared: true,
			// Stufe „Lesen“: kein Absender – Antworten gehen über einen eigenen Absender
			senderKey: x.level === 'edit' ? x.key : null
		});
	}
	if (core.permissions.has(ctx, PERM_INBOX_MANAGE)) {
		out.push({
			key: UNASSIGNED,
			kind: 'unassigned',
			address: '',
			name: 'Nicht zugeordnet',
			shared: true,
			senderKey: null
		});
	}
	return out;
}

/** Postfach prüfen; fremd/unbekannt → 404 (Existenz nicht verraten) */
export async function requireMailbox(ctx: RequestContext, key: string): Promise<AccessibleMailbox> {
	const found = (await accessibleMailboxes(ctx)).find((m) => m.key === key);
	if (!found) throw errors.notFound('Postfach nicht gefunden');
	return found;
}
