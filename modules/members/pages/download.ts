/** Lädt eine PDF-Antwort der API und startet den Download im Browser. */
export async function downloadPdf(
	url: string,
	init: RequestInit,
	fallbackName: string
): Promise<void> {
	const headers = new Headers(init.headers);
	if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
	const res = await fetch(url, { ...init, headers, credentials: 'same-origin' });
	if (!res.ok) {
		const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
		throw new Error(b?.error?.message ?? 'PDF konnte nicht erzeugt werden');
	}
	const name =
		/filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
	const blob = await res.blob();
	const href = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = href;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
