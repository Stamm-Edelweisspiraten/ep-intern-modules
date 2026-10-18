/**
 * Datei über die API laden und als Download speichern (Session-Cookie).
 * Eigene Kopie im Modul – Module importieren sich nicht gegenseitig.
 */
export async function downloadApiFile(path: string, fallbackName: string): Promise<void> {
	const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
		throw new Error(body?.error?.message ?? 'Datei konnte nicht geladen werden');
	}
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const name =
		/filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
