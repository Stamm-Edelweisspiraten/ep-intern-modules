/**
 * Empfänger auflösen: ausgewählte Mitglieder und/oder Gruppen → eindeutige E-Mail-Adressen.
 *
 * Bereich: Wer `members.member.view` hat, darf alle Mitglieder (Gruppen zusätzlich `members.group.view`).
 * Gruppenleitungen (`members.led-member.view`) nur die Mitglieder ihrer eigenen Gruppen; alles andere → 404.
 * Der Server löst Adressen immer selbst auf – Adressen aus dem Browser werden nie übernommen.
 */
import { core, errors, type RequestContext } from '$lib/sdk/server';
import type { MembersService } from '$lib/modules/members/contract';
import { dedupeAddresses, normalizeAddress } from './sender';
import { loadSettings } from './sender.service';
import {
	MAX_GROUP_IDS,
	MAX_MEMBER_IDS,
	MODULE_ID,
	type RecipientsInput,
	type RecipientsResult,
	type ResolvedRecipient
} from './schemas';
import { todayBerlin } from '$lib/sdk/dates';

async function membersService(): Promise<MembersService> {
	return core.modules.use<MembersService>('members', MODULE_ID);
}

/** Mitglieder-IDs aus Gruppen und Einzelauswahl, geprüft gegen den Bereich der Person */
async function memberIdsInScope(ctx: RequestContext, input: RecipientsInput): Promise<string[]> {
	const members = await membersService();
	const all = core.permissions.has(ctx, 'members.member.view');
	const led = !all && core.permissions.has(ctx, 'members.led-member.view');
	if (!all && !led) throw errors.forbidden('Berechtigung fehlt: members.member.view');

	let allowedGroups: Set<string> | null = null;
	if (led) allowedGroups = new Set((await members.listLedGroups(ctx)).map((g) => g.id));
	else if (input.groupIds.length && !core.permissions.has(ctx, 'members.group.view')) {
		throw errors.forbidden('Berechtigung fehlt: members.group.view');
	}

	const groupIds = [...new Set(input.groupIds)].slice(0, MAX_GROUP_IDS);
	if (allowedGroups && groupIds.some((id) => !allowedGroups.has(id))) {
		throw errors.notFound('Gruppe nicht gefunden');
	}
	const byGroup = groupIds.length ? await members.listGroupMemberIds(groupIds) : {};
	const fromGroups = Object.values(byGroup).flat();

	const explicit = [...new Set(input.memberIds)].slice(0, MAX_MEMBER_IDS);
	if (allowedGroups && explicit.length) {
		// Gruppenleitung: nur Mitglieder der eigenen Gruppen (alle anderen → 404, Existenz nicht verraten)
		const ledByGroup = await members.listGroupMemberIds([...allowedGroups]);
		const allowedMembers = new Set(Object.values(ledByGroup).flat());
		if (explicit.some((id) => !allowedMembers.has(id))) {
			throw errors.notFound('Mitglied nicht gefunden');
		}
	}
	const exclude = new Set(input.excludeMemberIds);
	return [...new Set([...explicit, ...fromGroups])].filter((id) => !exclude.has(id));
}

/** Eindeutige Empfängerliste (eine Zeile je Adresse) mit Hinweisen zu fehlenden Adressen */
export async function resolveRecipients(
	ctx: RequestContext,
	input: RecipientsInput
): Promise<RecipientsResult> {
	const settings = await loadSettings();
	const ids = await memberIdsInScope(ctx, input);
	const empty: RecipientsResult = {
		recipients: [],
		members: 0,
		withoutEmail: [],
		exited: 0,
		maxRecipients: settings.maxRecipients
	};
	if (!ids.length) return empty;

	const members = await membersService();
	const today = todayBerlin();
	const contacts = [];
	for (let i = 0; i < ids.length; i += 1000) {
		contacts.push(
			...(await members.listMemberContacts({ ids: ids.slice(i, i + 1000), limit: 1000 }))
		);
	}
	if (contacts.length < ids.length) throw errors.notFound('Mitglied nicht gefunden');

	const withoutEmail: { id: string; name: string }[] = [];
	const rows: ResolvedRecipient[] = [];
	let exited = 0;
	let withAddress = 0;
	for (const c of contacts) {
		if (c.exitDate && c.exitDate <= today) {
			exited++;
			continue;
		}
		const name = `${c.firstName} ${c.lastName}`.trim();
		const addresses = c.emails.map(normalizeAddress).filter(Boolean);
		if (!addresses.length) {
			withoutEmail.push({ id: c.id, name });
			continue;
		}
		withAddress++;
		for (const address of addresses) rows.push({ memberId: c.id, name, address });
	}
	return {
		recipients: dedupeAddresses(rows),
		members: withAddress,
		withoutEmail,
		exited,
		maxRecipients: settings.maxRecipients
	};
}
