/**
 * Probestunden-Formular der Stammeswebsite → Posteingang der passenden Gruppe.
 *
 * Gruppe: der von der Website gewählte Slug (Gruppe auf der Website), sonst die Gruppe, deren Altersangabe zum
 * Alter des Kindes passt (`groupsForAge`, bei mehreren die erste – Meuten vor Sippen). Die Anfrage landet im
 * Gruppen-Postfach (`group:<id>`, Kontakt-E-Mail der Gruppe), sofern dort mindestens eine Leitung mit Konto mitliest;
 * sonst im Stamm-Postfach (mit Hinweis auf die Gruppe), ohne Stamm-Adresse in „Nicht zugeordnet“.
 * Spam-Schutz wie beim Kontaktformular (gleiche Aufgabe, nur einmal einlösbar). Core nie in der Modul-Transaktion.
 */
import { core, type RequestContext } from '$lib/sdk/server';
import type { MembersService, WebsiteGroupRef } from '$lib/modules/members/contract';
import { groupsForAge } from './age-range';
import {
	requirePow,
	stammMailbox,
	storeWebsiteRequest,
	type WebsiteMailbox
} from './contact.service';
import { UNASSIGNED } from './mailbox';
import { loadMailboxDirectory } from './mailbox.service';
import { MODULE_ID, type TrialInput } from './schemas';

const TYPE_LABELS: Record<WebsiteGroupRef['type'], string> = { meute: 'Meute', sippe: 'Sippe' };

const groupLabel = (g: WebsiteGroupRef) => `${TYPE_LABELS[g.type]} ${g.name}`;

/** Gruppe für die Anfrage: gewählter Slug vor Altersabgleich; `null` = keine passende Gruppe */
export function pickTrialGroup(
	groups: WebsiteGroupRef[],
	input: Pick<TrialInput, 'groupSlug' | 'childAge'>
): { group: WebsiteGroupRef; chosen: boolean; exact: boolean } | null {
	const chosen = input.groupSlug ? groups.find((g) => g.slug === input.groupSlug) : undefined;
	if (chosen) {
		const fit = groupsForAge([chosen], input.childAge);
		return { group: chosen, chosen: true, exact: fit.exact };
	}
	const match = groupsForAge(groups, input.childAge);
	const first = match.groups[0];
	return first ? { group: first, chosen: false, exact: match.exact } : null;
}

export function trialSubject(input: Pick<TrialInput, 'childName' | 'childAge'>): string {
	return `Probestunde: ${input.childName} (${input.childAge} Jahre)`;
}

/** Klartext der Anfrage */
export function trialText(
	input: TrialInput,
	pick: ReturnType<typeof pickTrialGroup>,
	deliveredToGroup: boolean
): string {
	const groupLine = pick
		? `${groupLabel(pick.group)}${pick.group.ageRange ? ` (${pick.group.ageRange})` : ''}` +
			(pick.chosen ? ' – auf der Website ausgewählt' : ' – passend zum Alter') +
			(pick.exact ? '' : ' (Alter liegt außerhalb der Altersangabe)')
		: 'keine passende Gruppe gefunden';
	return [
		'Neue Anfrage für eine Probestunde über die Website.',
		'',
		`Kind: ${input.childName}`,
		`Alter: ${input.childAge} Jahre`,
		`Gruppe: ${groupLine}`,
		...(pick && !deliveredToGroup
			? [
					'',
					'Hinweis: Die Gruppe hat kein Postfach mit Leitung im Intern-Bereich – bitte weiterleiten.'
				]
			: []),
		'',
		`Ansprechperson: ${input.name}`,
		`E-Mail: ${input.email}`,
		`Telefon: ${input.phone}`,
		...(input.message ? ['', 'Nachricht:', input.message] : []),
		'',
		'—',
		'Über das Probestunden-Formular der Website eingegangen. Name und Adresse wurden nicht geprüft.'
	].join('\n');
}

export async function receiveTrial(
	ctx: RequestContext,
	input: TrialInput
): Promise<{ received: true; group: string | null }> {
	requirePow(input.pow);

	const members = await core.modules.use<MembersService>('members', MODULE_ID);
	const pick = pickTrialGroup(await members.listWebsiteGroupRefs(), input);
	const directory = await loadMailboxDirectory();
	const entry = pick ? directory.find((e) => e.key === `group:${pick.group.id}`) : undefined;

	let mailbox: WebsiteMailbox;
	if (entry && entry.userIds.length) {
		mailbox = { key: entry.key, name: entry.name, address: entry.address };
	} else {
		mailbox = await stammMailbox();
	}
	const deliveredToGroup = mailbox.key.startsWith('group:');

	await storeWebsiteRequest(ctx, {
		mailbox,
		pow: input.pow,
		from: { address: input.email, name: input.name },
		subject: trialSubject(input),
		text: trialText(input, pick, deliveredToGroup),
		auditAction: 'messages.inbox.trial-received',
		auditMailbox: deliveredToGroup ? 'group' : mailbox.key === UNASSIGNED ? UNASSIGNED : 'stamm',
		directory
	});
	return { received: true, group: pick ? pick.group.slug : null };
}
