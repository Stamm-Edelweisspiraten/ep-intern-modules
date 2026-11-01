import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { ArchiveError, assertNoZip64, unpackArchive } from '$modules/actions/action-archive';

/** Kopie mit veränderten Bytes im End-of-Central-Directory */
function patchEocd(zip: Uint8Array, patch: (view: DataView, eocd: number) => void): Uint8Array {
	const out = zip.slice();
	const view = new DataView(out.buffer);
	const eocd = out.byteLength - 22; // fflate schreibt keinen Kommentar
	expect(view.getUint32(eocd, true)).toBe(0x06054b50);
	patch(view, eocd);
	return out;
}

describe('ZIP64-Abwehr (Issue #21)', () => {
	const zip = zipSync({ 'manifest.json': strToU8('{}') });

	it('normales Archiv passiert', () => {
		expect(() => assertNoZip64(zip)).not.toThrow();
		expect(unpackArchive(zip).has('manifest.json')).toBe(true);
	});

	it('ZIP64-Marker in der Eintragszahl → ArchiveError', () => {
		const bad = patchEocd(zip, (v, e) => v.setUint16(e + 10, 0xffff, true));
		expect(() => unpackArchive(bad)).toThrow(ArchiveError);
		expect(() => unpackArchive(bad)).toThrow(/ZIP64/);
	});

	it('ZIP64-Marker im Offset des Verzeichnisses → ArchiveError', () => {
		const bad = patchEocd(zip, (v, e) => v.setUint32(e + 16, 0xffffffff, true));
		expect(() => assertNoZip64(bad)).toThrow(/ZIP64/);
	});

	it('ZIP64-Locator vor dem EOCD → ArchiveError', () => {
		const locator = new Uint8Array(20);
		new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
		const eocd = zip.byteLength - 22;
		const bad = new Uint8Array(zip.byteLength + 20);
		bad.set(zip.subarray(0, eocd), 0);
		bad.set(locator, eocd);
		bad.set(zip.subarray(eocd), eocd + 20);
		expect(() => assertNoZip64(bad)).toThrow(/ZIP64/);
	});

	it('ohne End-of-Central-Directory → ArchiveError', () => {
		const bad = zip.slice(0, zip.byteLength - 22);
		expect(() => assertNoZip64(bad)).toThrow(ArchiveError);
	});
});
