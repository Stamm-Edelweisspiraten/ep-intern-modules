import { ApiClientError, apiFetch } from '$lib/sdk/client';
import type { MyFieldDefinition, MyMember } from '../schemas';

export const MY_BASE = '/modules/members';

export function loadMyMembers(): Promise<MyMember[]> {
	return apiFetch<MyMember[]>(`${MY_BASE}/my/members`);
}

export async function loadMyFields(): Promise<MyFieldDefinition[]> {
	const r = await apiFetch<{ fields: MyFieldDefinition[] }>(`${MY_BASE}/my/fields`);
	return r.fields;
}

export const memberName = (m: Pick<MyMember, 'firstName' | 'lastName' | 'scoutName'>) =>
	`${m.firstName} ${m.lastName}`.trim();

export const errorText = (e: unknown, fallback: string) => {
	if (!(e instanceof ApiClientError)) return fallback;
	if (e.status === 429) {
		return 'Zu viele Änderungen in kurzer Zeit. Bitte warte ein paar Minuten und versuche es dann erneut.';
	}
	return e.message;
};

/** Zod-Issues aus `ApiClientError.details` als Pfad (`phones.0.value`) → Text */
export function issuesFrom(e: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!(e instanceof ApiClientError)) return out;
	const d = e.details;
	const list = Array.isArray(d) ? d : (d as { issues?: unknown[] } | null)?.issues;
	if (!Array.isArray(list)) return out;
	for (const i of list as { path?: (string | number)[]; message?: string }[]) {
		if (!i.message) continue;
		const key = (i.path ?? []).map(String).join('.');
		if (!out[key]) out[key] = i.message;
	}
	return out;
}

/** Zeilenfehler für `ContactListField` aus Issues (`phones.2.value`) */
export function contactErrors(
	issues: Record<string, string>,
	prefix: 'phones' | 'emails'
): Record<number, { name?: string; value?: string }> {
	const out: Record<number, { name?: string; value?: string }> = {};
	for (const [k, msg] of Object.entries(issues)) {
		const m = new RegExp(`^${prefix}\\.(\\d+)\\.(name|value)$`).exec(k);
		if (m) (out[Number(m[1])] ??= {})[m[2] as 'name' | 'value'] = msg;
	}
	return out;
}
