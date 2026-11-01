/**
 * Testwelt für Datensicherungs-Tests: frische PGlite-DB, alle Module aktiv, Beispieldaten in jedem Modul.
 *
 * - Storage: Fake-S3 aus `fake-storage.ts`, aber das **echte DB-FileRepo** (Core-Tabelle der Dateien), damit Export/Restore
 *   die Dateizeilen sieht. Die Bytes liegen in `fakeObjects` (Schlüssel = Objekt-Key).
 * - Secrets: `core.smtp.password` und `core.storage.secretAccessKey` (verschlüsselte Einstellungen), 2FA-Zeile der zweiten
 *   Person (Better-Auth-Verschlüsselung), IBANs in `actions` und `treasury`, Link-Token in `files` (`token_enc` + Hash).
 * - Aufräumen: `world.close()` (DB schließen, Fake-Storage aushängen).
 */
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { symmetricEncrypt } from 'better-auth/crypto';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage, fakeObjects } from '$testing';
import { getDb, schema } from '$lib/server/core/database/client';
import { contextForUser } from '$lib/server/core/auth/context';
import { getAuth } from '$lib/server/core/auth';
import { bootstrapAdmin, createUser } from '$lib/server/core/auth/users';
import { createRole } from '$lib/server/core/permissions/roles';
import { registerModule } from '$lib/server/core/modules/registry';
import { enableModule, syncModules } from '$lib/server/core/modules/service';
import { registerCoreApi } from '$lib/server/core/api/endpoints';
import { handleApiRequest } from '$lib/server/core/api/router';
import { createApiKey } from '$lib/server/core/api/keys';
import { setSetting } from '$lib/server/core/settings/service';
import { setFileRepoForTests } from '$lib/server/core/storage';
import { setMailTransportForTests } from '$lib/server/core/mail';
import { setPdfRendererForTests } from '$lib/server/core/pdf';
import { resetAllForTests } from '$lib/server/core/rate-limit';
import membersModule from '$modules/members/module';
import actionsModule from '$modules/actions/module';
import treasuryModule from '$modules/treasury/module';
import ordersModule from '$modules/orders/module';
import officesModule from '$modules/offices/module';
import eventsModule from '$modules/events/module';
import galleriesModule from '$modules/galleries/module';
import filesModule from '$modules/files/module';
import type { RequestContext } from '$lib/sdk/types';

export const SEED_PASSWORD = 'Sehr-Sicheres-Passwort-1';
export const SEED_ADMIN_EMAIL = 'admin@backup.test';
export const SEED_USER_EMAIL = 'tessa@backup.test';
export const SEED_TOTP_SECRET = 'BACKUPTESTSECRET2345';
export const SEED_SMTP_PASSWORD = 'smtp-geheim-2026';
export const SEED_PAYER_IBAN = 'DE89370400440532013000';
export const SEED_PAYEE_IBAN = 'DE02120300000000202051';
export const SEED_COUNTERPARTY_IBAN = 'DE75512108001245126199';

/** Reihenfolge = Abhängigkeiten (members → actions → treasury, members → orders) */
export const SEED_MODULES = [
	membersModule,
	actionsModule,
	treasuryModule,
	ordersModule,
	officesModule,
	eventsModule,
	galleriesModule,
	filesModule
];
export const SEED_MODULE_IDS = [
	'members',
	'actions',
	'treasury',
	'orders',
	'offices',
	'events',
	'galleries',
	'files'
] as const;

export interface BackupWorld {
	close: () => Promise<void>;
	adminId: string;
	userId: string;
	admin: RequestContext;
	user: RequestContext;
	/** API-Keys mit allen Rechten der Person */
	keys: { admin: string; user: string };
	/** Aufruf der REST-API (`/api/v1` + path), Antwort als `{ status, body }` */
	call: (
		who: 'admin' | 'user' | null,
		method: string,
		path: string,
		json?: unknown
	) => Promise<{ status: number; body: { data?: unknown; error?: { code?: string } } }>;
	/** IDs der angelegten Beispieldaten */
	ids: {
		roleId: string;
		memberIds: string[];
		actionId: string;
		payeeId: string;
		entryIds: string[];
		accountId: string;
		payerId: string;
		transactionId: string;
		invoiceId: string;
		articleId: string;
		officeId: string;
		eventId: string;
		galleryId: string;
		galleryImageId: string | null;
		folderRootId: string;
		folderChildId: string;
		fileId: string;
		fileBytes: Uint8Array;
		linkId: string;
		linkToken: string;
	};
	/** Fake-S3-Objekte (Schlüssel → Bytes) */
	objects: typeof fakeObjects;
	/** Mails, die über den Test-Transport gingen */
	mails: unknown[];
}

async function ctxOf(userId: string): Promise<RequestContext> {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function request(token: string | null, method: string, path: string, init: RequestInit) {
	resetAllForTests();
	const headers = new Headers(init.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	const res = await handleApiRequest({
		request: new Request(url, { ...init, method, headers }),
		url,
		ip: '127.0.0.1'
	});
	const text = await res.text();
	let body: { data?: unknown; error?: { code?: string } };
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	return { status: res.status, body };
}

/** Multipart-Upload mit `content-length` (manche Endpunkte verlangen ihn) */
async function multipart(token: string, path: string, fd: FormData) {
	const encoded = new Response(fd);
	const bytes = new Uint8Array(await encoded.arrayBuffer());
	return request(token, 'POST', path, {
		headers: {
			'content-type': encoded.headers.get('content-type')!,
			'content-length': String(bytes.byteLength)
		},
		body: bytes
	});
}

function ok<T>(r: { status: number; body: { data?: unknown } }, status = 200): T {
	expect(r.status, JSON.stringify(r.body)).toBe(status);
	return r.body.data as T;
}

export async function seedBackupWorld(): Promise<BackupWorld> {
	const { close: closeDb } = await useTestDatabase();
	registerCoreApi();
	for (const m of SEED_MODULES) registerModule(m);
	await syncModules();
	await bootstrapAdmin(SEED_ADMIN_EMAIL, SEED_PASSWORD);
	const [a] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, SEED_ADMIN_EMAIL));
	const adminId = a!.id;
	let admin = await ctxOf(adminId);
	for (const id of SEED_MODULE_IDS) await enableModule(admin, id);
	admin = await ctxOf(adminId);

	const mails: unknown[] = [];
	setMailTransportForTests({ sendMail: async (m) => void mails.push(m) });
	setPdfRendererForTests(async () => new TextEncoder().encode('%PDF-fake'));

	// Storage: Fake-S3, echtes DB-FileRepo
	await installFakeStorage(admin);
	setFileRepoForTests(undefined);
	await setSetting(admin, 'core.smtp.host', 'smtp.backup.test');
	await setSetting(admin, 'core.smtp.password', SEED_SMTP_PASSWORD);

	// zweite Person mit Rolle und 2FA
	const roleId = await createRole(admin, {
		name: 'Leitung',
		permissions: [
			'core.api.manage',
			'members.member.view',
			'events.event.view',
			'offices.office.view',
			'files.file.view',
			'galleries.gallery.view'
		].filter((p) => admin.permissions.has(p))
	});
	const userId = await createUser(admin, {
		name: 'Tessa Test',
		email: SEED_USER_EMAIL,
		password: SEED_PASSWORD,
		roleIds: [roleId]
	});
	const authCtx = await getAuth().$context;
	await getDb()
		.insert(schema.twoFactor)
		.values({
			id: crypto.randomUUID(),
			userId,
			secret: await symmetricEncrypt({ key: authCtx.secretConfig, data: SEED_TOTP_SECRET }),
			backupCodes: await symmetricEncrypt({
				key: authCtx.secretConfig,
				data: JSON.stringify(['1111111111', '2222222222'])
			})
		});
	await getDb()
		.update(schema.user)
		.set({ twoFactorEnabled: true })
		.where(eq(schema.user.id, userId));
	const user = await ctxOf(userId);

	const keys = {
		admin: (await createApiKey(admin, { name: 'seed', scopes: [...admin.permissions] })).key,
		user: (await createApiKey(user, { name: 'seed', scopes: [...user.permissions] })).key
	};
	const call: BackupWorld['call'] = (who, method, path, json) =>
		request(who ? keys[who] : null, method, path, {
			headers: json === undefined ? {} : { 'content-type': 'application/json' },
			body: json === undefined ? undefined : JSON.stringify(json)
		});
	const A = (method: string, path: string, json?: unknown) => call('admin', method, path, json);

	// members
	const memberIds: string[] = [];
	for (const [firstName, birthDate] of [
		['Lena', '2015-03-12'],
		['Paul', '2017-08-01']
	] as const) {
		const m = ok<{ id: string }>(
			await A('POST', '/modules/members/members', {
				firstName,
				lastName: 'Müller',
				birthDate,
				street: 'Lindenweg 4',
				postalCode: '28195',
				city: 'Bremen',
				stage: 'woelfling',
				emails: [{ name: 'Eltern', value: 'familie.mueller@example.test' }]
			}),
			201
		);
		memberIds.push(m.id);
	}

	// actions: Aktion, Empfänger*in mit IBAN, Ausgabe (Person) + Einnahme
	const actionId = ok<{ id: string }>(
		await A('POST', '/modules/actions/actions', {
			name: 'Sommerlager',
			description: null,
			location: 'Zeltplatz',
			startsOn: '2026-07-20',
			startsTime: null,
			endsOn: '2026-07-26',
			endsTime: null
		}),
		201
	).id;
	const payeeId = ok<{ id: string }>(
		await A('POST', `/modules/actions/actions/${actionId}/accounting/payees`, {
			name: 'Max Muster',
			iban: SEED_PAYEE_IBAN,
			bic: null,
			note: null
		}),
		201
	).id;
	const entryIds: string[] = [];
	for (const entry of [
		{
			type: 'expense',
			category: 'food',
			description: 'Einkauf',
			amountCents: 5000,
			entryDate: '2026-07-21',
			paidBy: 'person',
			payeeId
		},
		{
			type: 'income',
			category: 'contributions',
			description: 'Beiträge',
			amountCents: 20000,
			entryDate: '2026-07-01',
			paidBy: 'club',
			payeeId: null
		}
	]) {
		entryIds.push(
			ok<{ id: string }>(
				await A('POST', `/modules/actions/actions/${actionId}/accounting/entries`, entry),
				201
			).id
		);
	}

	// treasury: Konto, Zahler mit IBAN, Buchung mit Gegenpartei-IBAN, manuelle Rechnung
	const accountId = ok<{ id: string }>(
		await A('POST', '/modules/treasury/accounts', {
			name: 'Girokonto',
			kind: 'giro',
			openingDate: '2026-01-01'
		}),
		201
	).id;
	const payerId = ok<{ id: string }>(
		await A('POST', '/modules/treasury/payers', {
			name: 'Familie Müller',
			memberIds,
			iban: SEED_PAYER_IBAN
		}),
		201
	).id;
	const tx = ok<{ transaction?: { id: string }; id?: string }>(
		await A('POST', '/modules/treasury/transactions', {
			accountId,
			bookedOn: '2026-02-01',
			amountCents: 1500,
			counterparty: 'Spende Meier',
			purpose: 'Spende',
			counterpartyIban: SEED_COUNTERPARTY_IBAN
		}),
		201
	);
	const transactionId = tx.transaction?.id ?? tx.id ?? '';
	const invoiceId = ok<{ id: string }>(
		await A('POST', '/modules/treasury/invoices', {
			payerId,
			recipientName: 'Familie Müller',
			issuedOn: '2026-02-01',
			dueOn: '2026-03-01',
			lines: [{ description: 'Halstuch', amountCents: 800, memberId: memberIds[0] }]
		}),
		201
	).id;

	// orders: Artikel
	const articleId = ok<{ id: string }>(
		await A('POST', '/modules/orders/articles', {
			title: 'Halstuch',
			variants: [{ label: '', priceCents: 800 }]
		}),
		201
	).id;

	// offices: Amt mit Inhaberin (zweite Person) + Beschreibung
	const officeId = ok<{ id: string }>(
		await A('POST', '/modules/offices/offices', {
			name: 'Stammesführung',
			description: 'Leitet den Stamm',
			emails: [{ email: 'stafue@backup.test', label: 'Stafü' }],
			roleIds: []
		}),
		201
	).id;
	ok(
		await A('PUT', `/modules/offices/offices/${officeId}/holders`, {
			holders: [{ userId, since: '2025-09-01' }]
		})
	);

	// Vorlagen-Ämter (Kasse, Kämmerer*in) anlegen, wie beim ersten Aufruf der Ämterseite
	ok(await A('GET', '/modules/offices/offices'));

	// events: Termin für den Stamm
	const eventId = ok<{ id: string }>(
		await A('POST', '/modules/events/events', {
			title: 'Gruppenstunde',
			startsOn: '2026-03-05',
			startsTime: '17:00',
			endsOn: '2026-03-05',
			endsTime: '18:30',
			tags: ['wölflinge'],
			groupIds: ['stamm'],
			shares: [{ type: 'everyone', id: '*', level: 'read' }]
		}),
		201
	).id;

	// galleries: Galerie (öffentlich, am Termin) + ein Bild über den Fake-S3
	const galleryId = ok<{ id: string }>(
		await A('POST', '/modules/galleries/galleries', {
			title: 'Pfingstlager',
			description: null,
			visibility: 'public',
			consentConfirmed: true,
			shares: [],
			eventIds: [eventId]
		}),
		201
	).id;
	let galleryImageId: string | null = null;
	{
		const jpeg = new Uint8Array(
			await sharp({
				create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 20 } }
			})
				.jpeg()
				.toBuffer()
		);
		const fd = new FormData();
		fd.set('file', new File([jpeg as BlobPart], 'lager.jpg', { type: 'image/jpeg' }));
		const r = await multipart(keys.admin, `/modules/galleries/galleries/${galleryId}/images`, fd);
		if (r.status === 201) galleryImageId = (r.body.data as { id: string }).id;
	}

	// files: Ordnerbaum (Eltern → Kind → Datei), Freigabe an den Stamm, öffentlicher Link
	const folderRootId = ok<{ id: string }>(
		await A('POST', '/modules/files/folders', { parentId: null, name: 'Lager 2026' }),
		201
	).id;
	const folderChildId = ok<{ id: string }>(
		await A('POST', '/modules/files/folders', { parentId: folderRootId, name: 'Pläne' }),
		201
	).id;
	const fileBytes = new TextEncoder().encode('Packliste: Zelt, Schlafsack, Halstuch\n');
	const fd = new FormData();
	fd.set('file', new File([fileBytes as BlobPart], 'packliste.txt', { type: 'text/plain' }));
	const fileId = ok<{ id: string }>(
		await multipart(keys.admin, `/modules/files/nodes/${folderChildId}/upload`, fd),
		201
	).id;
	ok(
		await A('PUT', `/modules/files/nodes/${folderRootId}/shares`, {
			shares: [{ type: 'everyone', id: '*', level: 'read' }]
		})
	);
	const link = ok<{ id: string; url: string }>(
		await A('POST', `/modules/files/nodes/${folderRootId}/links`, {
			expiresOn: null,
			password: null
		}),
		201
	);

	return {
		close: async () => {
			uninstallFakeStorage();
			setMailTransportForTests(undefined);
			setPdfRendererForTests(undefined);
			await closeDb();
		},
		adminId,
		userId,
		admin: await ctxOf(adminId),
		user: await ctxOf(userId),
		keys,
		call,
		ids: {
			roleId,
			memberIds,
			actionId,
			payeeId,
			entryIds,
			accountId,
			payerId,
			transactionId,
			invoiceId,
			articleId,
			officeId,
			eventId,
			galleryId,
			galleryImageId,
			folderRootId,
			folderChildId,
			fileId,
			fileBytes,
			linkId: link.id,
			linkToken: String(link.url).split('/').pop()!
		},
		objects: fakeObjects,
		mails
	};
}
