/**
 * Videos in Galerien (reine Teile): Formaterkennung, Entfernen der Metadaten ohne Neukodierung,
 * Range-Anfragen (`parseRange`, `sliceStream`), Hilfen aus `schemas.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { parseRange, sliceStream } from '$modules/galleries/files';
import { formatDuration, uploadFields, videoTypeOf } from '$modules/galleries/schemas';
import { sniffVideoType, stripVideoMetadata } from '$modules/galleries/video';
import {
	box,
	contains,
	DEVICE_TEXT,
	GPS_TEXT,
	MDAT_PAYLOAD,
	sampleMp4,
	sampleWebm
} from '../video-fixtures';

describe('sniffVideoType', () => {
	it('erkennt MP4, MOV und WebM am Inhalt', () => {
		expect(sniffVideoType(sampleMp4('isom'))).toBe('video/mp4');
		expect(sniffVideoType(sampleMp4('qt  '))).toBe('video/quicktime');
		expect(sniffVideoType(sampleWebm())).toBe('video/webm');
		// altes QuickTime ohne ftyp
		expect(sniffVideoType(box('moov', box('mvhd', new Uint8Array(100))))).toBe('video/quicktime');
	});

	it('lehnt Bilder im ftyp-Container, Matroska ohne webm, Text und Leeres ab', () => {
		const ftyp = (brand: string) => box('ftyp', new TextEncoder().encode(brand), new Uint8Array(4));
		expect(sniffVideoType(ftyp('avif'))).toBeNull();
		expect(sniffVideoType(ftyp('heic'))).toBeNull();
		expect(sniffVideoType(ftyp('mif1'))).toBeNull();
		const mkv = sampleWebm();
		mkv.set(new TextEncoder().encode('mkvx'), mkv.indexOf(0x77)); // „webm“ → „mkvx“
		expect(sniffVideoType(mkv)).toBeNull();
		expect(sniffVideoType(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
		expect(sniffVideoType(new Uint8Array(0))).toBeNull();
	});
});

describe('stripVideoMetadata', () => {
	it('MP4/MOV: GPS und Gerät weg, Länge und Medienteil unverändert, Original unangetastet', () => {
		for (const brand of ['isom', 'qt  '] as const) {
			const original = sampleMp4(brand);
			const before = new Uint8Array(original);
			const { bytes, removed } = stripVideoMetadata(original, 'video/mp4');
			expect(removed).toBe(3); // moov/udta, moov/meta, trak/mdia/udta
			expect(bytes.length).toBe(original.length);
			expect(contains(bytes, GPS_TEXT)).toBe(false);
			expect(contains(bytes, DEVICE_TEXT)).toBe(false);
			expect(contains(bytes, 'com.apple.quicktime.location')).toBe(false);
			expect(contains(bytes, MDAT_PAYLOAD)).toBe(true);
			// Medienteil an derselben Stelle (Chunk-Offsets bleiben gültig)
			const at = Buffer.from(original).indexOf(Buffer.from(MDAT_PAYLOAD));
			expect(Buffer.from(bytes).indexOf(Buffer.from(MDAT_PAYLOAD))).toBe(at);
			expect(original).toEqual(before);
			expect(sniffVideoType(bytes)).toBe(brand === 'qt  ' ? 'video/quicktime' : 'video/mp4');
		}
	});

	it('MP4: abgeschnittene Box bricht nicht ab', () => {
		const cut = sampleMp4().subarray(0, 60);
		expect(() => stripVideoMetadata(cut, 'video/mp4')).not.toThrow();
	});

	it('WebM: Tags werden zu Void, Cluster unverändert', () => {
		const original = sampleWebm();
		const { bytes, removed } = stripVideoMetadata(original, 'video/webm');
		expect(removed).toBe(1);
		expect(bytes.length).toBe(original.length);
		expect(contains(bytes, GPS_TEXT)).toBe(false);
		expect(contains(bytes, DEVICE_TEXT)).toBe(false);
		expect(contains(bytes, MDAT_PAYLOAD)).toBe(true);
		expect(sniffVideoType(bytes)).toBe('video/webm');
	});
});

describe('parseRange', () => {
	it('einzelne Bereiche, offenes Ende, Suffix, gekappt', () => {
		expect(parseRange(null, 100)).toBeNull();
		expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
		expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
		expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
	});

	it('ungültig → invalid, mehrere Bereiche oder andere Einheit → ganze Datei', () => {
		expect(parseRange('bytes=100-', 100)).toBe('invalid');
		expect(parseRange('bytes=9-1', 100)).toBe('invalid');
		expect(parseRange('bytes=-', 100)).toBe('invalid');
		expect(parseRange('bytes=-0', 100)).toBe('invalid');
		expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
		expect(parseRange('items=0-1', 100)).toBeNull();
	});
});

describe('sliceStream', () => {
	async function read(stream: ReadableStream<Uint8Array>): Promise<number[]> {
		const out: number[] = [];
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return out;
			out.push(...value);
		}
	}
	function chunked(total: number, size: number) {
		let pulled = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				if (pulled >= total) return c.close();
				const n = Math.min(size, total - pulled);
				c.enqueue(Uint8Array.from({ length: n }, (_, i) => (pulled + i) % 256));
				pulled += n;
			},
			cancel() {
				cancelled = true;
			}
		});
		return { stream, pulled: () => pulled, cancelled: () => cancelled };
	}

	it('schneidet über Chunk-Grenzen hinweg und liest danach nicht weiter', async () => {
		const src = chunked(100, 7);
		const bytes = await read(sliceStream(src.stream, 10, 24));
		expect(bytes).toEqual(Array.from({ length: 15 }, (_, i) => 10 + i));
		expect(src.pulled()).toBeLessThan(100);
		expect(src.cancelled()).toBe(true);
	});

	it('ganzer Bereich und letztes Byte', async () => {
		expect((await read(sliceStream(chunked(20, 6).stream, 0, 19))).length).toBe(20);
		expect(await read(sliceStream(chunked(20, 6).stream, 19, 19))).toEqual([19]);
	});
});

describe('Schema-Hilfen', () => {
	it('videoTypeOf nach Typ oder Endung', () => {
		expect(videoTypeOf({ type: 'video/mp4', name: 'a' })).toBe('video/mp4');
		expect(videoTypeOf({ type: '', name: 'IMG_0001.MOV' })).toBe('video/quicktime');
		expect(videoTypeOf({ type: 'video/x-m4v', name: 'a.m4v' })).toBe('video/mp4');
		expect(videoTypeOf({ type: 'application/octet-stream', name: 'clip.webm' })).toBe('video/webm');
		expect(videoTypeOf({ type: 'image/jpeg', name: 'a.jpg' })).toBeNull();
		expect(videoTypeOf({ type: 'video/x-msvideo', name: 'a.avi' })).toBeNull();
	});

	it('formatDuration', () => {
		expect(formatDuration(null)).toBe('');
		expect(formatDuration(5)).toBe('0:05');
		expect(formatDuration(65.4)).toBe('1:05');
		expect(formatDuration(3725)).toBe('1:02:05');
	});

	it('uploadFields.duration: Text → Zahl, ungültig → Fehler', () => {
		expect(uploadFields.parse({ duration: '12.345' }).duration).toBe(12.3);
		expect(uploadFields.parse({}).duration).toBeNull();
		expect(uploadFields.safeParse({ duration: '-1' }).success).toBe(false);
		expect(uploadFields.safeParse({ duration: 'abc' }).success).toBe(false);
	});
});
