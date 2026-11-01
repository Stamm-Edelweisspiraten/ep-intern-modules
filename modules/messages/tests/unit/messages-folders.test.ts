import { describe, expect, it } from 'vitest';
import {
	buildFolderTree,
	descendantIds,
	flattenFolderTree,
	folderDepth,
	folderPath,
	nameTaken,
	subtreeHeight,
	wouldCycle,
	type FolderRef
} from '$modules/messages/folders';

//  Lager
//  ├─ Sommer
//  │  └─ Briefe
//  └─ Herbst
//  Ärger
const folders: FolderRef[] = [
	{ id: 'l', parentId: null, name: 'Lager' },
	{ id: 's', parentId: 'l', name: 'Sommer' },
	{ id: 'b', parentId: 's', name: 'Briefe' },
	{ id: 'h', parentId: 'l', name: 'Herbst' },
	{ id: 'a', parentId: null, name: 'Ärger' }
];

describe('Ordnerbaum im Posteingang', () => {
	it('baut den Baum alphabetisch (Umlaute deutsch) mit Tiefe', () => {
		const flat = flattenFolderTree(buildFolderTree(folders));
		expect(flat.map((f) => `${f.depth}:${f.folder.name}`)).toEqual([
			'1:Ärger',
			'1:Lager',
			'2:Herbst',
			'2:Sommer',
			'3:Briefe'
		]);
	});

	it('unbekannte Eltern landen oben, Zyklen brechen nicht', () => {
		const odd: FolderRef[] = [
			{ id: 'x', parentId: 'fehlt', name: 'Waise' },
			{ id: 'p', parentId: 'q', name: 'P' },
			{ id: 'q', parentId: 'p', name: 'Q' }
		];
		const flat = flattenFolderTree(buildFolderTree(odd));
		expect(flat.map((f) => f.folder.id)).toEqual(['x']);
	});

	it('Pfad, Tiefe, Nachfahren, Höhe', () => {
		expect(folderPath(folders, 'b').map((f) => f.name)).toEqual(['Lager', 'Sommer', 'Briefe']);
		expect(folderPath(folders, null)).toEqual([]);
		expect(folderDepth(folders, 'b')).toBe(3);
		expect(folderDepth(folders, 'unbekannt')).toBe(0);
		expect(descendantIds(folders, 'l').sort()).toEqual(['b', 'h', 's']);
		expect(descendantIds(folders, 'b')).toEqual([]);
		expect(subtreeHeight(folders, 'l')).toBe(3);
		expect(subtreeHeight(folders, 'h')).toBe(1);
	});

	it('Zyklus beim Verschieben erkennen', () => {
		expect(wouldCycle(folders, 'l', 'b')).toBe(true);
		expect(wouldCycle(folders, 'l', 'l')).toBe(true);
		expect(wouldCycle(folders, 's', 'h')).toBe(false);
		expect(wouldCycle(folders, 's', null)).toBe(false);
	});

	it('Name je Ebene, Groß/klein egal, eigener Ordner ausgenommen', () => {
		expect(nameTaken(folders, 'l', 'sommer')).toBe(true);
		expect(nameTaken(folders, null, 'Sommer')).toBe(false);
		expect(nameTaken(folders, 'l', 'Sommer', 's')).toBe(false);
	});
});
