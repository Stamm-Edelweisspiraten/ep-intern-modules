import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiLogPath } from '$testing';
import { allEndpoints, matchEndpoint } from '$testing';
import { registerModule, unregisterModule } from '$testing';
import actionsModule from '$modules/actions/module';
import filesModule from '$modules/files/module';
import membersModule from '$modules/members/module';

// Zugriffsprotokoll: Link-Tokens öffentlicher Endpunkte dürfen nie im Klartext im api_log stehen.

const TOKEN = 'Zq3vLk9xP2mN7rT4wY8bC1dF6gH0jK5s';
const UUID = '6f1c2b8e-3d4a-4b5c-9e7f-0a1b2c3d4e5f';

beforeAll(() => {
	for (const m of [membersModule, actionsModule, filesModule]) {
		try {
			registerModule(m);
		} catch {
			// bereits registriert (gemeinsamer Testprozess)
		}
	}
});

afterAll(() => {
	for (const id of ['files', 'actions', 'members']) unregisterModule(id);
});

/** Konkreter Pfad zum Muster: `:token` → Token, andere Parameter → UUID */
function concrete(fullPath: string): string {
	return fullPath
		.split('/')
		.map((s) => (s === ':token' ? TOKEN : s.startsWith(':') ? UUID : s))
		.join('/');
}

describe('apiLogPath', () => {
	it('protokolliert bei Treffern das Endpunkt-Muster', () => {
		expect(
			apiLogPath(
				`/api/v1/modules/files/public/links/${TOKEN}`,
				'/modules/files/public/links/:token'
			)
		).toBe('/api/v1/modules/files/public/links/:token');
	});

	it('maskiert alle öffentlichen Token-Endpunkte aus files, actions und members', () => {
		const publicWithToken = allEndpoints().filter((e) => e.public && e.fullPath.includes(':token'));
		const modules = new Set(publicWithToken.map((e) => e.moduleId));
		expect(modules).toEqual(new Set(['files', 'actions', 'members']));
		expect(publicWithToken.length).toBeGreaterThanOrEqual(12);
		for (const e of publicWithToken) {
			const pathname = `/api/v1${concrete(e.fullPath)}`;
			const { match } = matchEndpoint(e.method, pathname.slice('/api/v1'.length));
			expect(match?.endpoint.fullPath, pathname).toBe(e.fullPath);
			const logged = apiLogPath(pathname, match!.endpoint.fullPath);
			expect(logged).not.toContain(TOKEN);
			expect(logged).not.toContain(UUID);
			expect(logged).toContain(':token');
		}
	});

	it('maskiert token-artige Segmente, wenn kein Endpunkt passt', () => {
		expect(apiLogPath(`/api/v1/modules/files/public/links/${TOKEN}/gibt-es-nicht`)).toBe(
			'/api/v1/modules/files/public/links/:param/gibt-es-nicht'
		);
		expect(apiLogPath(`/api/v1/x/${UUID}`)).toBe('/api/v1/x/:param');
		expect(apiLogPath(`/api/v1/x/${'a'.repeat(80)}.txt`)).toBe('/api/v1/x/:param');
		// kurze, sprechende Segmente bleiben lesbar
		expect(apiLogPath('/api/v1/modules/offices/offices/order')).toBe(
			'/api/v1/modules/offices/offices/order'
		);
	});

	it('begrenzt die Länge auf 300 Zeichen', () => {
		expect(apiLogPath(`/api/v1/${'abc/'.repeat(200)}`).length).toBe(300);
	});
});
