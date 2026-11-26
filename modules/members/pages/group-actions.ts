/** Gemeinsame Helfer für Gruppenliste und Gruppenseite (nur Client). */
import { type Group, type MemberRef, WEEKDAY_LABELS } from '../schemas';

export const GROUPS_PATH = '/modules/members/groups';

export const groupHref = (id: string) => `${GROUPS_PATH}/${encodeURIComponent(id)}`;
export const memberHref = (id: string) => `/modules/members?open=${encodeURIComponent(id)}`;

/** Auswahl an „Neue Nachricht“ übergeben (Modul messages, Schlüssel `messages:compose`) */
export function composeFor(groupIds: string[]) {
	try {
		sessionStorage.setItem('messages:compose', JSON.stringify({ groupIds }));
	} catch {
		// ohne Speicher startet die Nachricht ohne Vorauswahl
	}
	location.assign('/modules/messages/new');
}

export function personName(m: Pick<MemberRef, 'firstName' | 'lastName' | 'scoutName'>) {
	const base = `${m.firstName} ${m.lastName}`;
	return m.scoutName ? `${m.scoutName} (${base})` : base;
}

/** Leitende Mitglieder und Konten */
export function leaderNames(g: Group): string[] {
	return [...g.leaders.map(personName), ...g.leaderUsers.map((u) => u.name)];
}

export function imageUrl(g: Group) {
	return `/api/v1/modules/members/groups/${g.id}/image?v=${encodeURIComponent(g.imageVersion ?? '')}`;
}

/** „Freitag, 16:30–18:00“ bzw. Teile davon; `null` ohne Angaben */
export function meetingText(g: Group): string | null {
	const day = g.meetingWeekday ? WEEKDAY_LABELS[g.meetingWeekday] : null;
	const time =
		g.meetingTime && g.meetingEndTime ? `${g.meetingTime}–${g.meetingEndTime}` : g.meetingTime;
	if (day && time) return `${day}, ${time}`;
	return day ?? time ?? null;
}

export const memberCountText = (n: number) => (n === 1 ? '1 Mitglied' : `${n} Mitglieder`);
