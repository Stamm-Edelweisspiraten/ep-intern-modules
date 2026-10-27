/**
 * Export/Import einer Aktion als ZIP (siehe action-archive.ts für Format und Grenzen).
 *
 *   GET  /actions/:id/export   Basisrecht view + Lesezugriff
 *   POST /actions/import       Basisrecht create; multipart `file`
 *
 * Core-Services (storage, crypto, audit) laufen immer außerhalb der Modul-Transaktion.
 */
import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import {
	type ApiEndpoint,
	core,
	errors,
	isCoreError,
	moduleDb,
	readUpload,
	type RequestContext,
	rowsOf,
	toIsoOrNull,
	type Tx
} from '$lib/sdk/server';
import { formDefinitionSchema } from '$lib/forms/schema';
import { requireAccess } from './access';
import { linkTokenValues } from './link-tokens';
import { closedInfo, loadRefundSnapshot } from './accounting-core';
import {
	ARCHIVE_FORMAT,
	ARCHIVE_VERSION,
	ARCHIVE_ZIP_TYPES,
	ArchiveError,
	MAX_ARCHIVE_BYTES,
	MAX_EXPORT_RECEIPT_BYTES,
	archiveFilename,
	buildArchive,
	detectReceiptType,
	parseArchive,
	sanitizeName,
	type ArchiveDocument,
	type ArchiveManifest
} from './action-archive';
import {
	buildDefaultFormDefinition,
	mergeStandardFields,
	normalizeDedupeKey
} from './form-support';
import { ibanLast, isValidIban, normalizeIban } from './iban';
import { canSeeHealth, healthColumns, readHealthFor } from './health';
import {
	CHECKLIST_ITEMS,
	MAX_RECEIPT_BYTES,
	MODULE_ID,
	idParams,
	type CalcBasis,
	type CalcCategory,
	type FreizeitType,
	type LodgingType
} from './schemas';

const TAGS = ['Modul: actions'];
const crypt = () => core.crypto.forModule(MODULE_ID);

const str = (v: unknown): string | null => (v == null ? null : String(v));
const decryptOrNull = (enc: unknown): string | null => {
	if (enc == null) return null;
	try {
		return crypt().decrypt(String(enc));
	} catch {
		return null;
	}
};
const bool = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

function jsonOf(v: unknown): unknown {
	if (typeof v === 'string') {
		try {
			return JSON.parse(v);
		} catch {
			return null;
		}
	}
	return v;
}

function asObject(v: unknown): Record<string, unknown> {
	const o = jsonOf(v);
	return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
}

const newToken = () =>
	crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

function validationError(message: string): never {
	throw errors.validation({ file: message }, message);
}

// === Export =================================================================

interface ExportRows {
	action: Record<string, unknown>;
	calc: Record<string, unknown> | null;
	calcItems: Record<string, unknown>[];
	participants: Record<string, unknown>[];
	form: Record<string, unknown> | null;
	payees: Record<string, unknown>[];
	entries: Record<string, unknown>[];
	refund: Awaited<ReturnType<typeof loadRefundSnapshot>>;
	closed: Awaited<ReturnType<typeof closedInfo>>;
}

async function loadExportRows(tx: Tx, id: string): Promise<ExportRows> {
	const [action] = await rowsOf(
		tx,
		sql`SELECT name, description, location, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
				starts_time, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, ends_time,
				fee_cents, team_fee_cents, is_past
			FROM actions WHERE id = ${id}`
	);
	if (!action) throw errors.notFound('Aktion nicht gefunden');
	const [calc] = await rowsOf(tx, sql`SELECT * FROM action_calculations WHERE action_id = ${id}`);
	return {
		action,
		calc: calc ?? null,
		calcItems: await rowsOf(
			tx,
			sql`SELECT category, label, amount_cents, basis FROM calc_items
				WHERE action_id = ${id} ORDER BY position, id`
		),
		participants: await rowsOf(
			tx,
			sql`SELECT id, name, group_label, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
					bremen_resident, role, juleica, subsidy_eligible, diet, allergies, notes,
					contact_email, source, consent_accepted_at, answers, health_answers
				FROM action_participants WHERE action_id = ${id} ORDER BY created_at, name, id`
		),
		form: (await rowsOf(tx, sql`SELECT * FROM action_forms WHERE action_id = ${id}`))[0] ?? null,
		payees: await rowsOf(
			tx,
			sql`SELECT id, name, iban_enc, bic, note FROM accounting_payees
				WHERE action_id = ${id} ORDER BY created_at, name, id`
		),
		entries: await rowsOf(
			tx,
			sql`SELECT id, type, category, description, amount_cents,
					to_char(entry_date, 'YYYY-MM-DD') AS entry_date, paid_by, payee_id,
					receipt_path, receipt_name, receipt_content_type, reimbursed_at, reimbursed_upfront,
					recipient_name, recipient_iban_enc, recipient_bic, purpose, club_paid_at
				FROM accounting_entries WHERE action_id = ${id} ORDER BY entry_date, created_at, id`
		),
		refund: await loadRefundSnapshot(tx, id),
		closed: await closedInfo(tx, id)
	};
}

function cleanDisplayName(v: unknown): string {
	const t = [...String(v ?? '')]
		.filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
		.join('')
		.trim()
		.slice(0, 200);
	return t || 'Beleg';
}

async function exportAction(ctx: RequestContext, id: string): Promise<Response> {
	const rows = await moduleDb(MODULE_ID).transaction(async (tx) => {
		await requireAccess(tx, ctx, id, 'read');
		return loadExportRows(tx, id);
	});

	const withBank = core.permissions.has(ctx, 'actions.payout.view');
	// Gesundheitsdaten (Ernährung, Allergien, Sonstiges, gesundheitsbezogene Antworten) nur mit Sonderrecht
	const withHealth = canSeeHealth(ctx);
	const canReadFiles = core.permissions.has(ctx, 'actions.storage.read');

	// Export-IDs nach Reihenfolge: stabil über Export -> Import -> Export
	const pid = new Map(rows.participants.map((p, i) => [String(p.id), `p${i + 1}`]));
	const yid = new Map(rows.payees.map((p, i) => [String(p.id), `y${i + 1}`]));
	const eid = new Map(rows.entries.map((e, i) => [String(e.id), `e${i + 1}`]));

	// Belege (Core-Storage, außerhalb der Transaktion)
	const receipts = new Map<string, Uint8Array>();
	const receiptOf = new Map<string, { file: string; name: string; contentType: string }>();
	let missing = 0;
	let storageDown = false;
	let totalBytes = 0;
	for (const e of rows.entries) {
		if (e.receipt_path == null) continue;
		if (!canReadFiles || storageDown) {
			missing += 1;
			continue;
		}
		try {
			const { buffer } = await core.storage.download(ctx, {
				module: MODULE_ID,
				path: String(e.receipt_path)
			});
			const type = detectReceiptType(buffer);
			if (
				!type ||
				buffer.byteLength === 0 ||
				buffer.byteLength > MAX_RECEIPT_BYTES ||
				totalBytes + buffer.byteLength > MAX_EXPORT_RECEIPT_BYTES
			) {
				missing += 1;
				continue;
			}
			totalBytes += buffer.byteLength;
			const name = cleanDisplayName(e.receipt_name);
			const file = `receipts/${eid.get(String(e.id))}-${sanitizeName(name)}`;
			receipts.set(file, new Uint8Array(buffer));
			receiptOf.set(String(e.id), { file, name, contentType: type });
		} catch (err) {
			missing += 1;
			if (isCoreError(err) && err.code === 'unavailable') storageDown = true;
		}
	}

	const calc = rows.calc;
	const checklistRaw = calc ? asObject(calc.checklist) : {};
	const checklist: Record<string, boolean> = {};
	for (const item of CHECKLIST_ITEMS) {
		if (item.key in checklistRaw) checklist[item.key] = Boolean(checklistRaw[item.key]);
	}

	let definition = buildDefaultFormDefinition();
	if (rows.form) {
		const parsed = formDefinitionSchema.safeParse(jsonOf(rows.form.definition));
		if (parsed.success) definition = mergeStandardFields(parsed.data);
	}

	const document: ArchiveDocument = {
		action: {
			name: String(rows.action.name),
			description: str(rows.action.description),
			location: str(rows.action.location),
			startsOn: String(rows.action.starts_on),
			startsTime: str(rows.action.starts_time),
			endsOn: str(rows.action.ends_on),
			endsTime: str(rows.action.ends_time),
			isPast: rows.action.is_past === true || rows.action.is_past === 't',
			feeCents: rows.action.fee_cents == null ? null : Number(rows.action.fee_cents),
			teamFeeCents: rows.action.team_fee_cents == null ? null : Number(rows.action.team_fee_cents)
		},
		calculation: calc
			? {
					participants: Number(calc.participants),
					team: Number(calc.team),
					teamPercent: Number(calc.team_percent),
					nights: Number(calc.nights),
					bufferPercent: Number(calc.buffer_percent),
					includeSubsidy: Boolean(calc.include_subsidy),
					lodgingType: String(calc.lodging_type) as LodgingType,
					konfi: Boolean(calc.konfi),
					freizeitType: String(calc.freizeit_type) as FreizeitType,
					bremenChildren: Number(calc.bremen_children),
					bremenYouth: Number(calc.bremen_youth),
					teamWithJuleica: Number(calc.team_with_juleica),
					teamWithoutJuleica: Number(calc.team_without_juleica),
					teamYouth: Number(calc.team_youth),
					checklist,
					items: rows.calcItems.map((r) => ({
						category: String(r.category) as CalcCategory,
						label: String(r.label),
						amountCents: Number(r.amount_cents),
						basis: String(r.basis) as CalcBasis
					}))
				}
			: null,
		participants: rows.participants.map((p) => {
			const h = readHealthFor(ctx, p, definition.fields);
			return {
				id: pid.get(String(p.id))!,
				name: String(p.name),
				groupLabel: str(p.group_label),
				birthDate: str(p.birth_date),
				bremenResident: bool(p.bremen_resident),
				role: String(p.role) as 'participant' | 'team',
				juleica: Boolean(p.juleica),
				subsidyEligible: bool(p.subsidy_eligible),
				diet: h.diet,
				allergies: h.allergies,
				notes: h.notes,
				contactEmail: str(p.contact_email),
				source: String(p.source) === 'link' ? 'link' : 'manual',
				consentAcceptedAt: toIsoOrNull(p.consent_accepted_at),
				answers: h.answers as ArchiveDocument['participants'][number]['answers']
			};
		}),
		form: rows.form
			? {
					opensAt: toIsoOrNull(rows.form.opens_at),
					closesAt: toIsoOrNull(rows.form.closes_at),
					maxParticipants:
						rows.form.max_participants == null ? null : Number(rows.form.max_participants),
					intro: str(rows.form.intro),
					disclaimerTemplate: String(rows.form.disclaimer_template ?? ''),
					privacyUrl: str(rows.form.privacy_url),
					definition
				}
			: null,
		payees: rows.payees.map((p) => {
			const base = {
				id: yid.get(String(p.id))!,
				name: String(p.name),
				bic: str(p.bic),
				note: str(p.note)
			};
			if (!withBank) return base;
			let iban: string | null = null;
			if (p.iban_enc) {
				try {
					iban = crypt().decrypt(String(p.iban_enc));
				} catch {
					iban = null;
				}
			}
			return { ...base, iban };
		}),
		entries: rows.entries.map((e) => ({
			id: eid.get(String(e.id))!,
			type: String(e.type) as 'income' | 'expense',
			category: String(e.category) as ArchiveDocument['entries'][number]['category'],
			description: String(e.description),
			amountCents: Number(e.amount_cents),
			entryDate: String(e.entry_date),
			paidBy: String(e.paid_by) as 'club' | 'person',
			payeeRef: e.payee_id == null ? null : (yid.get(String(e.payee_id)) ?? null),
			receipt: receiptOf.get(String(e.id)) as ArchiveDocument['entries'][number]['receipt'],
			reimbursedAt: toIsoOrNull(e.reimbursed_at),
			...(e.reimbursed_upfront === true ? { reimbursedUpfront: true } : {}),
			transfer:
				e.type === 'expense' && e.paid_by === 'club' && e.category !== 'refund'
					? {
							recipientName: str(e.recipient_name),
							...(withBank ? { iban: decryptOrNull(e.recipient_iban_enc) } : {}),
							bic: str(e.recipient_bic),
							purpose: str(e.purpose),
							paidAt: toIsoOrNull(e.club_paid_at)
						}
					: null
		})),
		refund: rows.refund
			? {
					entryRef: rows.refund.entryId ? (eid.get(rows.refund.entryId) ?? null) : null,
					mode: rows.refund.mode,
					bookedAt: rows.refund.bookedAt,
					surplusCents: rows.refund.surplusCents,
					perHeadCents: rows.refund.perHeadCents,
					payingCount: rows.refund.payingCount,
					remainderCents: rows.refund.remainderCents,
					...(rows.refund.deadline ? { deadline: rows.refund.deadline } : {}),
					items: rows.refund.items.map((i) => ({
						participantRef: i.participantId == null ? null : (pid.get(i.participantId) ?? null),
						name: i.name,
						amountCents: i.amountCents,
						...(i.donatedCents > 0 ? { donatedCents: i.donatedCents } : {})
					}))
				}
			: null,
		accounting: { closed: !!rows.closed, closedAt: rows.closed?.at ?? null }
	};
	// Einträge ohne exportierten Beleg tragen `receipt: null`
	for (const e of document.entries) e.receipt = e.receipt ?? null;

	const counts = {
		participants: document.participants.length,
		entries: document.entries.length,
		receipts: receipts.size,
		payees: document.payees.length,
		formFields: document.form?.definition.fields.length ?? 0
	};
	const manifest: ArchiveManifest = {
		format: ARCHIVE_FORMAT,
		formatVersion: ARCHIVE_VERSION,
		exportedAt: new Date().toISOString(),
		appVersion: 'actions/1.0.0',
		...(missing > 0
			? { receiptsOmitted: !canReadFiles || storageDown, receiptsMissing: missing }
			: {}),
		contents: {
			participants: counts.participants,
			entries: counts.entries,
			receipts: counts.receipts,
			payees: counts.payees,
			includesBank: withBank,
			includesHealth: withHealth
		}
	};
	const zip = buildArchive({ manifest, document, receipts });

	await core.audit.logFromContext(ctx, 'actions.action.exported', {
		target: id,
		metadata: { actionId: id, counts, withBank, withHealth }
	});
	return new Response(zip as BodyInit, {
		status: 200,
		headers: {
			'content-type': 'application/zip',
			'content-length': String(zip.byteLength),
			'content-disposition': `attachment; filename="${archiveFilename(document.action.name, todayBerlin())}"`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
}

// === Import =================================================================

interface ImportResult {
	id: string;
	name: string;
	counts: {
		participants: number;
		entries: number;
		receipts: number;
		payees: number;
		formFields: number;
	};
	warnings: string[];
}

async function importAction(ctx: RequestContext, request: Request): Promise<ImportResult> {
	if (!ctx.userId) throw errors.unauthenticated();
	const ownerId = ctx.userId;

	// Feld/leer/Typ → 422, Größe → 413 (#33); den ZIP-Inhalt prüft parseArchive
	const file = await readUpload(request, {
		maxBytes: MAX_ARCHIVE_BYTES,
		allowedTypes: ARCHIVE_ZIP_TYPES,
		typesLabel: 'ZIP-Archiv',
		detectMissingType: true,
		sniff: false
	});

	let parsed;
	try {
		parsed = parseArchive(file.bytes);
	} catch (e) {
		if (e instanceof ArchiveError) validationError(e.message);
		throw e;
	}
	const { manifest, document: doc, files } = parsed;

	// Belege vorbereiten (Typ per Magic Bytes, Größe)
	const warnings: string[] = [];
	const receiptJobs: {
		exportId: string;
		bytes: Uint8Array;
		name: string;
		contentType: string;
	}[] = [];
	const referenced = new Set<string>();
	for (const e of doc.entries) {
		if (!e.receipt) continue;
		referenced.add(e.receipt.file);
		const bytes = files.get(e.receipt.file)!;
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECEIPT_BYTES) {
			validationError('Ein Beleg ist leer oder größer als 10 MB');
		}
		const type = detectReceiptType(bytes);
		if (!type) validationError('Ein Beleg hat keinen erlaubten Dateityp (PDF, JPEG, PNG, WebP)');
		receiptJobs.push({ exportId: e.id, bytes, name: e.receipt.name, contentType: type });
	}
	for (const name of files.keys()) {
		if (name.startsWith('receipts/') && !referenced.has(name)) {
			warnings.push(
				`Datei "${name.slice(9)}" im Archiv gehört zu keiner Buchung und wurde ignoriert.`
			);
		}
	}
	if (receiptJobs.length > 0) {
		await core.permissions.require(ctx, 'actions.storage.write');
	}

	// IBANs prüfen und verschlüsseln (Core-Crypto, außerhalb der Transaktion)
	const canPayout = core.permissions.has(ctx, 'actions.payout.view');
	const payeeIban = new Map<string, { enc: string; last: string }>();
	let ibanSkipped = 0;
	for (const p of doc.payees) {
		if (!p.iban) continue;
		if (!canPayout) {
			ibanSkipped += 1;
			continue;
		}
		if (!isValidIban(p.iban)) {
			warnings.push(
				`Die IBAN von „${p.name}“ ist ungültig; der Empfänger wurde ohne IBAN angelegt.`
			);
			continue;
		}
		const normalized = normalizeIban(p.iban);
		payeeIban.set(p.id, { enc: crypt().encrypt(normalized), last: ibanLast(normalized) });
	}
	const entryIban = new Map<string, { enc: string; last: string }>();
	for (const e of doc.entries) {
		const iban = e.transfer?.iban;
		if (!iban) continue;
		if (!canPayout) {
			ibanSkipped += 1;
			continue;
		}
		if (!isValidIban(iban)) {
			warnings.push(
				`Die IBAN der Ausgabe „${e.description}“ ist ungültig; sie wurde ohne IBAN angelegt.`
			);
			continue;
		}
		const normalized = normalizeIban(iban);
		entryIban.set(e.id, { enc: crypt().encrypt(normalized), last: ibanLast(normalized) });
	}
	if (ibanSkipped > 0) {
		warnings.push(
			`${ibanSkipped} IBAN(s) wurden nicht übernommen, weil das Recht „Auszahlungen einsehen“ fehlt.`
		);
	}
	if (manifest.receiptsOmitted) {
		warnings.push('Das Archiv wurde ohne Belege exportiert; Belege müssen neu hochgeladen werden.');
	} else if (manifest.receiptsMissing) {
		warnings.push(
			`${manifest.receiptsMissing} Beleg(e) konnten beim Export nicht mitgegeben werden.`
		);
	}
	if (doc.form) {
		warnings.push(
			'Das Anmeldeformular wurde übernommen, ist aber deaktiviert und hat einen neuen Link.'
		);
	}

	// Neue IDs
	const actionId = crypto.randomUUID();
	const pids = new Map(doc.participants.map((p) => [p.id, crypto.randomUUID()]));
	const yids = new Map(doc.payees.map((p) => [p.id, crypto.randomUUID()]));
	const eids = new Map(doc.entries.map((e) => [e.id, crypto.randomUUID()]));

	// Belege hochladen (erst Storage, dann DB; bei Fehlern best-effort aufräumen)
	const uploaded: string[] = [];
	const receiptPath = new Map<string, { path: string; name: string; contentType: string }>();
	const cleanup = async () => {
		for (const path of uploaded) {
			await core.storage.remove(ctx, { module: MODULE_ID, path }).catch(() => undefined);
		}
	};
	try {
		for (const job of receiptJobs) {
			const entryId = eids.get(job.exportId)!;
			const path = `${actionId}/${entryId}-${crypto.randomUUID()}-${sanitizeName(job.name)}`;
			await core.storage.upload(ctx, {
				module: MODULE_ID,
				path,
				file: job.bytes,
				contentType: job.contentType,
				name: job.name
			});
			uploaded.push(path);
			receiptPath.set(job.exportId, { path, name: job.name, contentType: job.contentType });
		}

		const base = Date.now();
		const stamp = (i: number) => new Date(base + i).toISOString();
		const now = new Date(base).toISOString();
		const seenDedupe = new Set<string>();

		await moduleDb(MODULE_ID).transaction(async (tx) => {
			const a = doc.action;
			await tx.execute(
				sql`INSERT INTO actions (id, name, description, location, starts_on, starts_time, ends_on,
						ends_time, owner_id, fee_cents, team_fee_cents, fee_applied_at, fee_applied_by, is_past)
					VALUES (${actionId}, ${a.name}, ${a.description}, ${a.location}, ${a.startsOn},
						${a.startsTime}, ${a.endsOn}, ${a.endsTime}, ${ownerId}, ${a.feeCents},
						${a.teamFeeCents}, ${a.feeCents == null ? null : now},
						${a.feeCents == null ? null : ownerId}, ${a.isPast ?? false})`
			);

			const c = doc.calculation;
			if (c) {
				const validKeys = new Set<string>(CHECKLIST_ITEMS.map((i) => i.key));
				const checklist: Record<string, boolean> = {};
				for (const [k, v] of Object.entries(c.checklist)) if (validKeys.has(k)) checklist[k] = v;
				await tx.execute(
					sql`INSERT INTO action_calculations (action_id, participants, team, team_percent, nights,
							buffer_percent, include_subsidy, lodging_type, konfi, freizeit_type, bremen_children,
							bremen_youth, team_with_juleica, team_without_juleica, team_youth, checklist,
							updated_by, updated_at)
						VALUES (${actionId}, ${c.participants}, ${c.team}, ${c.teamPercent}, ${c.nights},
							${c.bufferPercent}, ${c.includeSubsidy}, ${c.lodgingType}, ${c.konfi},
							${c.freizeitType}, ${c.bremenChildren}, ${c.bremenYouth}, ${c.teamWithJuleica},
							${c.teamWithoutJuleica}, ${c.teamYouth}, ${JSON.stringify(checklist)}::jsonb,
							${ownerId}, ${now})`
				);
				for (const [position, item] of c.items.entries()) {
					await tx.execute(
						sql`INSERT INTO calc_items (id, action_id, category, label, amount_cents, basis, position)
							VALUES (${crypto.randomUUID()}, ${actionId}, ${item.category}, ${item.label},
								${item.amountCents}, ${item.basis}, ${position})`
					);
				}
			}

			if (doc.form) {
				const f = doc.form;
				const definition = mergeStandardFields(f.definition);
				const fresh = linkTokenValues(newToken());
				await tx.execute(
					sql`INSERT INTO action_forms (action_id, token_hash, token_enc, enabled, opens_at, closes_at,
							max_participants, definition, intro, disclaimer_template, privacy_url,
							updated_by, updated_at)
						VALUES (${actionId}, ${fresh.hash}, ${fresh.enc}, false, ${f.opensAt}, ${f.closesAt},
							${f.maxParticipants}, ${JSON.stringify(definition)}::jsonb, ${f.intro},
							${f.disclaimerTemplate}, ${f.privacyUrl}, ${ownerId}, ${now})`
				);
			}

			for (const [i, p] of doc.participants.entries()) {
				let dedupe: string | null = null;
				if (p.source === 'link' && p.birthDate) {
					const key = normalizeDedupeKey(p.name, p.birthDate);
					if (!seenDedupe.has(key)) {
						seenDedupe.add(key);
						dedupe = key;
					}
				}
				// Gesundheitsdaten verschlüsselt; fehlen sie im Archiv (Export ohne Sonderrecht), bleiben sie leer
				const h = healthColumns(p, doc.form?.definition.fields ?? []);
				await tx.execute(
					sql`INSERT INTO action_participants (id, action_id, name, group_label, birth_date,
							bremen_resident, role, juleica, subsidy_eligible, diet, allergies, notes, answers,
							health_answers, source, consent_accepted_at, contact_email, dedupe_key, created_at,
							updated_at)
						VALUES (${pids.get(p.id)!}, ${actionId}, ${p.name}, ${p.groupLabel}, ${p.birthDate},
							${p.bremenResident}, ${p.role}, ${p.juleica}, ${p.subsidyEligible}, ${h.diet},
							${h.allergies}, ${h.notes}, ${h.answers}::jsonb, ${h.healthAnswers}, ${p.source},
							${p.consentAcceptedAt}, ${p.contactEmail || null}, ${dedupe}, ${stamp(i)}, ${stamp(i)})`
				);
			}

			for (const [i, p] of doc.payees.entries()) {
				const enc = payeeIban.get(p.id);
				await tx.execute(
					sql`INSERT INTO accounting_payees (id, action_id, name, iban_enc, iban_last4, bic, note,
							created_at)
						VALUES (${yids.get(p.id)!}, ${actionId}, ${p.name}, ${enc?.enc ?? null},
							${enc?.last ?? null}, ${p.bic}, ${p.note}, ${stamp(i)})`
				);
			}

			for (const [i, e] of doc.entries.entries()) {
				const r = receiptPath.get(e.id);
				const t = e.transfer ?? null;
				const iban = entryIban.get(e.id);
				// Stamm-Ausgaben älterer Archive (ohne `transfer`) gelten als bezahlt
				const clubExpense = e.type === 'expense' && e.paidBy === 'club' && e.category !== 'refund';
				const paidAt = t ? t.paidAt : clubExpense ? stamp(i) : null;
				await tx.execute(
					sql`INSERT INTO accounting_entries (id, action_id, type, category, description,
							amount_cents, entry_date, paid_by, payee_id, receipt_path, receipt_name,
							receipt_content_type, reimbursed_at, reimbursed_upfront, created_by, created_at, updated_at,
							recipient_name, recipient_iban_enc, recipient_iban_last4, recipient_bic, purpose,
							club_paid_at, club_paid_via)
						VALUES (${eids.get(e.id)!}, ${actionId}, ${e.type}, ${e.category}, ${e.description},
							${e.amountCents}, ${e.entryDate}, ${e.paidBy},
							${e.payeeRef ? yids.get(e.payeeRef)! : null}, ${r?.path ?? null},
							${r?.name ?? null}, ${r?.contentType ?? null}, ${e.reimbursedAt}, ${e.reimbursedUpfront === true}, ${ownerId},
							${stamp(i)}, ${stamp(i)}, ${t?.recipientName ?? null}, ${iban?.enc ?? null},
							${iban?.last ?? null}, ${t?.bic ?? null}, ${t?.purpose ?? null}, ${paidAt},
							${paidAt ? 'manual' : null})`
				);
			}

			if (doc.refund) {
				const r = doc.refund;
				const entryId = r.entryRef ? eids.get(r.entryRef)! : null;
				for (const [position, item] of r.items.entries()) {
					const donated = item.donatedCents ?? 0;
					await tx.execute(
						sql`INSERT INTO accounting_refunds
								(id, action_id, entry_id, participant_id, name, amount_cents, position,
									donated_cents, decided_at, decided_via)
							VALUES (${crypto.randomUUID()}, ${actionId}, ${entryId},
								${item.participantRef ? pids.get(item.participantRef)! : null}, ${item.name},
								${item.amountCents}, ${position}, ${donated},
								${donated > 0 ? now : null}, ${donated > 0 ? 'internal' : null})`
					);
				}
				await tx.execute(
					sql`INSERT INTO action_refund_booking (action_id, entry_id, surplus_cents, per_head_cents,
							paying_count, remainder_cents, booked_at, booked_by, mode, choice_deadline)
						VALUES (${actionId}, ${entryId}, ${r.surplusCents}, ${r.perHeadCents},
							${r.payingCount}, ${r.remainderCents}, ${r.bookedAt}, ${ownerId}, ${r.mode},
							${r.deadline ?? null})`
				);
			}

			if (doc.accounting.closed) {
				await tx.execute(
					sql`INSERT INTO action_accounting (action_id, closed_at, closed_by)
						VALUES (${actionId}, ${doc.accounting.closedAt ?? now}, ${ownerId})`
				);
			}
		});
	} catch (e) {
		await cleanup();
		throw e;
	}

	const counts = {
		participants: doc.participants.length,
		entries: doc.entries.length,
		receipts: receiptPath.size,
		payees: doc.payees.length,
		formFields: doc.form?.definition.fields.length ?? 0
	};
	await core.audit.logFromContext(ctx, 'actions.action.imported', {
		target: actionId,
		metadata: { actionId, counts }
	});
	return { id: actionId, name: doc.action.name, counts, warnings };
}

export const exportImportEndpoints: ApiEndpoint[] = [
	{
		method: 'GET',
		path: '/actions/:id/export',
		summary: 'Aktion samt Daten und Belegen als ZIP exportieren',
		description:
			'Klartext-IBANs nur mit actions.payout.view, Belege nur mit actions.storage.read. Ohne Freigaben, Benutzer-IDs, Audit.',
		tags: TAGS,
		permission: 'actions.action.view',
		params: idParams,
		handler: async ({ ctx, params }) => exportAction(ctx, (params as { id: string }).id)
	} as ApiEndpoint,
	{
		method: 'POST',
		path: '/actions/import',
		summary: 'Aktion aus einem ZIP-Export importieren (multipart, Feld "file")',
		description:
			'Legt immer eine neue Aktion an (Eigentümer*in = Importierende*r). Mit Belegen ist actions.storage.write nötig. Höchstens 200 MB.',
		tags: TAGS,
		permission: 'actions.action.create',
		handler: async ({ ctx, request }) => importAction(ctx, request)
	} as ApiEndpoint
] as ApiEndpoint[];
